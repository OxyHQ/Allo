Pod::Spec.new do |s|
  s.name = 'AlloTones'
  s.version = '1.0.0'
  s.summary = 'Allo conversation tones as system sounds'
  s.description = s.summary
  s.author = 'Oxy'
  s.homepage = 'https://allo.you'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AudioToolbox'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
