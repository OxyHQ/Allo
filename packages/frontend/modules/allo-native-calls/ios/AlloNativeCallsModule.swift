import ExpoModulesCore
import PushKit
import CallKit
import AVFoundation

// No Oxy bearer or MLS key is available to this layer. The OS UI is a hint;
// all actions wait for the enrolled, restored SDK to confirm server authority.
final class AlloCalls: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = AlloCalls()
  let defaults = UserDefaults.standard
  var registry: PKPushRegistry?
  var provider: CXProvider!
  var actions: [String: CXAction] = [:]
  var calls: [String: UUID] = [:]
  var audioActive = false
  var ended: [String: Double] {
    get { defaults.dictionary(forKey: "allo.calls.ended") as? [String: Double] ?? [:] }
    set { defaults.set(newValue, forKey: "allo.calls.ended") }
  }
  var queue: [[String: String]] {
    get { defaults.array(forKey: "allo.calls.queue") as? [[String: String]] ?? [] }
    set { defaults.set(Array(newValue.suffix(16)), forKey: "allo.calls.queue") }
  }
  override init() {
    super.init()
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = true
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    provider.setDelegate(self, queue: .main)
    for item in queue {
      if let id = item["callId"], let raw = item["nativeUUID"], let uuid = UUID(uuidString: raw) { calls[id] = uuid }
    }
  }
  func start() {
    guard registry == nil else { return }
    let next = PKPushRegistry(queue: .main)
    next.delegate = self
    next.desiredPushTypes = [.voIP]
    registry = next
  }
  func bind(_ account: String, _ instance: String) {
    if defaults.string(forKey: "allo.calls.instance") != instance { clear() }
    defaults.set(account, forKey: "allo.calls.account")
    defaults.set(instance, forKey: "allo.calls.instance")
    start()
  }
  func clear() {
    for id in Array(calls.keys) { end(id) }
    queue = []
    defaults.removeObject(forKey: "allo.calls.account")
    defaults.removeObject(forKey: "allo.calls.instance")
  }
  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    defaults.set(pushCredentials.token.map { String(format: "%02x", $0) }.joined(), forKey: "allo.calls.token")
  }
  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    defaults.removeObject(forKey: "allo.calls.token")
  }
  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    var data = payload.dictionaryPayload.reduce(into: [String: String]()) { out, item in
      if let key = item.key as? String, let value = item.value as? String { out[key] = value }
    }
    // Always report a VoIP push before completing, including stale/foreign hints.
    // Apple requires this even when the server state will subsequently reject it.
    let id = data["callId"] ?? UUID().uuidString
    if calls[id] != nil { completion(); return }
    let uuid = UUID()
    calls[id] = uuid
    data["nativeUUID"] = uuid.uuidString
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: "Allo")
    update.localizedCallerName = "Allo"
    update.hasVideo = data["mode"] == "video"
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportNewIncomingCall(with: uuid, update: update) { error in
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      let expires = formatter.date(from: data["expiresAt"] ?? "") ?? .distantPast
      let valid = error == nil && (self.ended[id] ?? 0) < Date().timeIntervalSince1970 && data["type"] == "allo.call"
        && data["instanceId"] == self.defaults.string(forKey: "allo.calls.instance")
        && data["accountId"] == self.defaults.string(forKey: "allo.calls.account")
        && expires > Date()
      if valid {
        self.enqueue(data, action: "ring")
        DispatchQueue.main.asyncAfter(deadline: .now() + min(45, expires.timeIntervalSinceNow)) {
          if self.queue.contains(where: { $0["callId"] == id && $0["action"] == "ring" }) { self.end(id) }
        }
      } else { self.end(id) }
      completion()
    }
  }
  func enqueue(_ data: [String: String], action: String) {
    var item = data
    item["action"] = action
    item["eventId"] = UUID().uuidString
    queue = queue.filter { $0["callId"] != item["callId"] } + [item]
  }
  func perform(_ action: CXCallAction, kind: String) {
    guard let id = calls.first(where: { $0.value == action.callUUID })?.key,
          let data = queue.first(where: { $0["callId"] == id }) else { action.fail(); return }
    actions[id] = action
    enqueue(data, action: kind)
    // CallKit has its own timeout as well. Never leave an unanswered OS action
    // hanging indefinitely if identity restoration or the network is unavailable.
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
      if self.actions[id] === action {
        action.fail()
        self.actions.removeValue(forKey: id)
        let pending = self.queue.first(where: { $0["callId"] == id })
        self.end(id)
        if let pending = pending { self.enqueue(pending, action: "end") }
      }
    }
  }
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) { perform(action, kind: "answer") }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) { perform(action, kind: "end") }
  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) { action.fail() }
  func providerDidReset(_ provider: CXProvider) { clear() }
  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { audioActive = true }
  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { audioActive = false }
  func acknowledge(_ event: String, success: Bool, terminal: Bool) {
    guard let data = queue.first(where: { $0["eventId"] == event }), let id = data["callId"] else { return }
    if let action = actions.removeValue(forKey: id) { if success {
        if action is CXAnswerCallAction {
          do { try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth]) }
          catch { action.fail(); end(id); return }
        }
        action.fulfill()
      } else { action.fail() } }
    if terminal || !success { end(id) }
    else if data["action"] == "answer" { enqueue(data, action: "active") }
    // Keep ring metadata until an action or authoritative end: this is also the
    // native expiry timer's source of truth. JS tracks acknowledged event IDs.
  }
  func end(_ id: String) {
    var tombstones = ended.filter { $0.value > Date().timeIntervalSince1970 }
    tombstones[id] = Date().timeIntervalSince1970 + 90
    ended = Dictionary(uniqueKeysWithValues: tombstones.sorted { $0.value > $1.value }.prefix(64).map { ($0.key, $0.value) })
    if let action = actions.removeValue(forKey: id) { action.fail() }
    if let uuid = calls.removeValue(forKey: id) { provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded) }
    queue = queue.filter { $0["callId"] != id }
  }
}

public final class AlloCallsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    if userInfo["type"] as? String == "allo.call.end", let id = userInfo["callId"] as? String,
      userInfo["instanceId"] as? String == AlloCalls.shared.defaults.string(forKey: "allo.calls.instance") {
      AlloCalls.shared.end(id)
      completionHandler(.newData)
    } else { completionHandler(.noData) }
  }
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    AlloCalls.shared.start()
    return true
  }
}
public final class AlloNativeCallsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlloNativeCalls")
    AsyncFunction("bind") { (account: String, instance: String) in AlloCalls.shared.bind(account, instance) }.runOnQueue(.main)
    AsyncFunction("clear") { (instance: String?) in
      if instance == nil || AlloCalls.shared.defaults.string(forKey: "allo.calls.instance") == instance { AlloCalls.shared.clear() }
    }.runOnQueue(.main)
    AsyncFunction("snapshot") { () -> [String: Any] in
      let calls = AlloCalls.shared
      return ["token": calls.defaults.string(forKey: "allo.calls.token") ?? "", "events": calls.queue, "audioActive": calls.audioActive]
    }.runOnQueue(.main)
    AsyncFunction("acknowledge") { (event: String, success: Bool, terminal: Bool) in AlloCalls.shared.acknowledge(event, success: success, terminal: terminal) }.runOnQueue(.main)
    AsyncFunction("end") { (id: String) in AlloCalls.shared.end(id) }.runOnQueue(.main)
  }
}
