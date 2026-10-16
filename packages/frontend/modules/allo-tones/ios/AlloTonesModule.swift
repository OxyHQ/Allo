import AudioToolbox
import Foundation
import ExpoModulesCore

// A conversation tone is an alert, not media, so it goes through System Sound
// Services rather than the shared AVAudioSession: it is silent when the
// Ring/Silent switch is, plays at the ringer volume, never interrupts the
// user's music, and does not care what category expo-audio, expo-video or
// WebRTC last left the session in.
public class AlloTonesModule: Module {
  private var sounds: [String: SystemSoundID] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("AlloTones")

    // `uri` is a local `file://` URL (expo-asset's `localUri`).
    Function("play") { (uri: String) in
      guard let url = URL(string: uri), url.isFileURL else { return }
      guard let sound = self.sound(for: url, key: uri) else { return }
      AudioServicesPlaySystemSound(sound)
    }

    OnDestroy {
      self.lock.lock()
      defer { self.lock.unlock() }
      for sound in self.sounds.values {
        AudioServicesDisposeSystemSoundID(sound)
      }
      self.sounds.removeAll()
    }
  }

  private func sound(for url: URL, key: String) -> SystemSoundID? {
    lock.lock()
    defer { lock.unlock() }
    if let cached = sounds[key] { return cached }
    var created: SystemSoundID = 0
    guard AudioServicesCreateSystemSoundID(url as CFURL, &created) == kAudioServicesNoError else {
      return nil
    }
    sounds[key] = created
    return created
  }
}
