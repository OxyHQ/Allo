package you.allo.calls

import android.app.*
import android.content.*
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.*
import android.telecom.*
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.RemoteMessage
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

// Only opaque routing coordinates cross this boundary; credentials and call
// authorization remain in the restored Oxy + signed Allo SDK session.
object CallState {
  val connections = mutableMapOf<String, Connection>()
  private fun prefs(c: Context) = c.getSharedPreferences("allo-native-calls", Context.MODE_PRIVATE)
  @Synchronized fun events(c: Context): List<Map<String, String>> {
    val rows = JSONArray(prefs(c).getString("events", "[]"))
    return (0 until rows.length()).map { n -> val row = rows.getJSONObject(n); row.keys().asSequence().associateWith { row.getString(it) } }
  }
  @Synchronized private fun save(c: Context, rows: List<Map<String, String>>) {
    prefs(c).edit().putString("events", JSONArray(rows.takeLast(16).map { JSONObject(it) }).toString()).commit()
  }
  @Synchronized fun enqueue(c: Context, data: Map<String, String>, action: String) {
    save(c, events(c).filter { it["callId"] != data["callId"] } + (data + mapOf("action" to action, "eventId" to UUID.randomUUID().toString())))
  }
  @Synchronized fun bind(c: Context, account: String, instance: String) {
    if (prefs(c).getString("instance", null) != instance) clear(c)
    prefs(c).edit().putString("account", account).putString("instance", instance).commit()
    val manager = c.getSystemService(TelecomManager::class.java)
    manager.registerPhoneAccount(PhoneAccount.builder(handle(c), "Allo").setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED).build())
    // The FCM token is what lets the server ring this phone while Allo is
    // closed. A build without google-services.json, or a phone without Google
    // Play services, has no Firebase: binding still succeeds (Telecom and the
    // durable action queue need no push), the token stays empty, and the SDK
    // clears the server's call-push binding instead of failing every second.
    if (com.google.firebase.FirebaseApp.getApps(c).isEmpty()) {
      token(c, "")
      return
    }
    runCatching {
      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token(c, it) }
        .addOnFailureListener { token(c, "") }
    }.onFailure { token(c, "") }
  }
  fun token(c: Context, value: String) { prefs(c).edit().putString("token", value).commit() }
  fun token(c: Context): String = prefs(c).getString("token", "") ?: ""
  fun handle(c: Context) = PhoneAccountHandle(ComponentName(c, AlloConnectionService::class.java), "allo")
  @Synchronized fun clear(c: Context, expected: String? = null) {
    if (expected != null && prefs(c).getString("instance", null) != expected) return
    events(c).mapNotNull { it["callId"] }.forEach { end(c, it) }
    prefs(c).edit().remove("account").remove("instance").remove("events").commit()
  }
  @Synchronized fun incoming(c: Context, data: Map<String, String>) {
    if (prefs(c).getString("instance", null) == null) return
    if (data["instanceId"] != prefs(c).getString("instance", null) || data["accountId"] != prefs(c).getString("account", null)) return
    val id = data["callId"] ?: return
    val expires = runCatching { Instant.parse(data["expiresAt"]).toEpochMilli() }.getOrDefault(0)
    if (prefs(c).getLong("ended.$id", 0) > System.currentTimeMillis() || expires <= System.currentTimeMillis() || events(c).any { it["callId"] == id }) return
    enqueue(c, data, "ring")
    try {
      val extras = Bundle().apply { putString("callId", id) }
      c.getSystemService(TelecomManager::class.java).addNewIncomingCall(handle(c), extras)
    } catch (_: Exception) { end(c, id) }
    Handler(Looper.getMainLooper()).postDelayed({
      if (events(c).any { it["callId"] == id && it["action"] == "ring" }) end(c, id)
    }, (expires - System.currentTimeMillis()).coerceIn(1, 45_000))
  }
  @Synchronized fun action(c: Context, id: String, action: String) {
    val data = events(c).find { it["callId"] == id } ?: return
    enqueue(c, data, action)
    if (action == "end") { connections[id]?.setDisconnected(DisconnectCause(DisconnectCause.REJECTED)); c.getSystemService(NotificationManager::class.java).cancel(id.hashCode()) }
    Handler(Looper.getMainLooper()).postDelayed({
      if (events(c).any { it["callId"] == id && it["action"] == action }) {
        end(c, id)
        enqueue(c, data, "end")
      }
    }, 20_000)
  }
  @Synchronized fun acknowledge(c: Context, event: String, success: Boolean, terminal: Boolean) {
    val data = events(c).find { it["eventId"] == event } ?: return
    val id = data["callId"] ?: return
    if (!success || terminal) { end(c, id); return }
    if (data["action"] == "answer") {
      connections[id]?.setActive()
      enqueue(c, data, "active")
      c.startService(Intent(c, AlloCallService::class.java).putExtra("callId", id))
    }
  }
  @Synchronized fun end(c: Context, id: String) {
    val edit = prefs(c).edit()
    prefs(c).all.filter { it.key.startsWith("ended.") }.entries.sortedByDescending { it.value as? Long ?: 0 }.forEachIndexed { index, entry ->
      if (index >= 63 || (entry.value as? Long ?: 0) <= System.currentTimeMillis()) edit.remove(entry.key)
    }
    edit.putLong("ended.$id", System.currentTimeMillis() + 90_000).commit()
    connections.remove(id)?.let { it.setDisconnected(DisconnectCause(DisconnectCause.REMOTE)); it.destroy() }
    save(c, events(c).filter { it["callId"] != id })
    c.getSystemService(NotificationManager::class.java).cancel(id.hashCode())
    if (events(c).isEmpty()) c.stopService(Intent(c, AlloCallService::class.java))
  }
  fun pending(c: Context, id: String, action: String): PendingIntent {
    val intent = Intent(c, AlloCallActionActivity::class.java).setData(Uri.parse("allo-native-call://$action/${Uri.encode(id)}"))
      .putExtra("callId", id).putExtra("action", action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
  fun open(c: Context) {
    c.packageManager.getLaunchIntentForPackage(c.packageName)?.let { c.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
  }
}

// Replace Expo's service, delegate ALL non-call messages and token events back
// to it. Two independent MESSAGING_EVENT services lose messages nondeterministically.
class AlloMessagingService : ExpoFirebaseMessagingService() {
  override fun onNewToken(token: String) { super.onNewToken(token); CallState.token(this, token) }
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.data["type"] == "allo.call") {
      if (remoteMessage.priority == RemoteMessage.PRIORITY_HIGH) CallState.incoming(this, remoteMessage.data)
    } else if (remoteMessage.data["type"] == "allo.call.end") {
      val id = remoteMessage.data["callId"]
      if (id != null && CallState.events(this).any { it["callId"] == id && it["instanceId"] == remoteMessage.data["instanceId"] }) CallState.end(this, id)
    } else super.onMessageReceived(remoteMessage)
  }
}
class AlloConnectionService : ConnectionService() {
  override fun onCreateIncomingConnection(handle: PhoneAccountHandle?, request: ConnectionRequest): Connection {
    val id = request.extras.getString("callId") ?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
    if (CallState.events(this).none { it["callId"] == id }) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.CANCELED))
    val context = this
    val connection = object : Connection() {
      override fun onShowIncomingCallUi() {
        try { context.startForegroundService(Intent(context, AlloCallService::class.java).putExtra("callId", id)) }
        catch (_: Exception) { CallState.end(context, id) }
      }
      override fun onAnswer() { CallState.action(context, id, "answer"); CallState.open(context) }
      override fun onAnswer(videoState: Int) { onAnswer() }
      override fun onReject() { CallState.action(context, id, "end"); CallState.open(context) }
      override fun onDisconnect() { CallState.action(context, id, "end"); CallState.open(context) }
    }
    connection.connectionProperties = Connection.PROPERTY_SELF_MANAGED
    connection.setCallerDisplayName("Allo", TelecomManager.PRESENTATION_ALLOWED)
    connection.setAddress(Uri.parse("allo:incoming"), TelecomManager.PRESENTATION_ALLOWED)
    connection.setAudioModeIsVoip(true)
    connection.setRinging()
    CallState.connections[id] = connection
    return connection
  }
  override fun onCreateIncomingConnectionFailed(handle: PhoneAccountHandle?, request: ConnectionRequest) { request.extras.getString("callId")?.let { CallState.end(this, it) } }
}
class AlloCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra("callId") ?: run { stopSelf(); return START_NOT_STICKY }
    val data = CallState.events(this).find { it["callId"] == id } ?: run { stopSelf(); return START_NOT_STICKY }
    val active = data["action"] == "active"
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel("allo-calls", getString(R.string.allo_calls_channel), NotificationManager.IMPORTANCE_HIGH).apply { lockscreenVisibility = Notification.VISIBILITY_PRIVATE })
    val end = CallState.pending(this, id, "end")
    val answer = CallState.pending(this, id, "answer")
    val open = CallState.pending(this, id, "open")
    val builder = Notification.Builder(this, "allo-calls").setSmallIcon(applicationInfo.icon)
      .setContentTitle("Allo").setContentText(getString(if (active) R.string.allo_call_active else R.string.allo_call_incoming))
      .setCategory(Notification.CATEGORY_CALL).setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOngoing(true).setContentIntent(open)
    if (!active) builder.setFullScreenIntent(open, true).setTimeoutAfter((Instant.parse(data["expiresAt"]).toEpochMilli() - System.currentTimeMillis()).coerceAtLeast(1))
    if (Build.VERSION.SDK_INT >= 31) {
      val person = Person.Builder().setName("Allo").setImportant(true).build()
      builder.setStyle(if (active) Notification.CallStyle.forOngoingCall(person, end) else Notification.CallStyle.forIncomingCall(person, end, answer))
    } else {
      builder.addAction(Notification.Action.Builder(null, getString(R.string.allo_call_decline), end).build())
      if (!active) builder.addAction(Notification.Action.Builder(null, getString(R.string.allo_call_answer), answer).build())
    }
    if (Build.VERSION.SDK_INT >= 29) startForeground(id.hashCode(), builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or (if (active && Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0))
    else startForeground(id.hashCode(), builder.build())
    return START_NOT_STICKY
  }
}
// A direct notification PendingIntent target avoids Android's prohibited
// notification→broadcast/service→activity trampoline.
class AlloCallActionActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    val id = intent.getStringExtra("callId")
    val action = intent.getStringExtra("action")
    if (id != null && action != null && action != "open") CallState.action(this, id, action)
    CallState.open(this)
    finish()
  }
}
class AlloNativeCallsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AlloNativeCalls")
    AsyncFunction("bind") { account: String, instance: String -> CallState.bind(appContext.reactContext!!, account, instance) }
    AsyncFunction("clear") { instance: String? -> CallState.clear(appContext.reactContext!!, instance) }
    AsyncFunction("snapshot") { val c = appContext.reactContext!!; mapOf("token" to CallState.token(c), "events" to CallState.events(c), "audioActive" to false) }
    AsyncFunction("acknowledge") { event: String, success: Boolean, terminal: Boolean -> CallState.acknowledge(appContext.reactContext!!, event, success, terminal) }
    AsyncFunction("end") { id: String -> CallState.end(appContext.reactContext!!, id) }
  }
}
