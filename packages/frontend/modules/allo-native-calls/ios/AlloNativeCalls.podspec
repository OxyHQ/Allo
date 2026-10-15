Pod::Spec.new do |s|
  s.name = 'AlloNativeCalls'
  s.version = '1.0.0'
  s.summary = 'Allo native incoming call lifecycle'
  s.description = s.summary
  s.author = 'Oxy'
  s.homepage = 'https://allo.you'
  s.license = 'MIT'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
