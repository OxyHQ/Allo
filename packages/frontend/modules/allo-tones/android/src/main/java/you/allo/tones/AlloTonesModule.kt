package you.allo.tones

import android.media.AudioAttributes
import android.media.SoundPool
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// A conversation tone is an alert, not media, so it plays on the notification
// stream (USAGE_NOTIFICATION_EVENT, CONTENT_TYPE_SONIFICATION): silent when the
// phone is on silent or vibrate, at the notification volume, and without
// taking audio focus from whatever else is playing. expo-audio's player is
// media and would ignore the ringer.
class AlloTonesModule : Module() {
  private val lock = Any()
  private var pool: SoundPool? = null
  private val ids = mutableMapOf<String, Int>()
  private val loaded = mutableSetOf<Int>()
  private val waiting = mutableSetOf<Int>()

  override fun definition() = ModuleDefinition {
    Name("AlloTones")

    // `uri` is a local `file://` URL (expo-asset's `localUri`).
    Function("play") { uri: String ->
      val path = Uri.parse(uri).takeIf { it.scheme == "file" }?.path ?: return@Function
      synchronized(lock) {
        val sounds = pool ?: create().also { pool = it }
        val id = ids.getOrPut(uri) { sounds.load(path, 1) }
        if (id in loaded) sounds.play(id, 1f, 1f, 1, 0, 1f) else waiting.add(id)
      }
    }

    OnDestroy {
      synchronized(lock) {
        pool?.release()
        pool = null
        ids.clear()
        loaded.clear()
        waiting.clear()
      }
    }
  }

  private fun create(): SoundPool {
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val sounds = SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attributes).build()
    // The first play of a tone arrives before it has loaded: play it once it has.
    sounds.setOnLoadCompleteListener { loadedPool, id, status ->
      synchronized(lock) {
        if (status != 0) {
          ids.entries.removeAll { it.value == id }
          waiting.remove(id)
          return@synchronized
        }
        loaded.add(id)
        if (waiting.remove(id)) loadedPool.play(id, 1f, 1f, 1, 0, 1f)
      }
    }
    return sounds
  }
}
