Pod::Spec.new do |s|
  s.name           = 'ExpoJuyunNative'
  s.version        = '1.11.0'
  s.summary        = 'Native Quick Look and streaming hash helpers for Juyun.'
  s.description    = 'Private native helpers used by the Juyun iOS application.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Juyun'
  s.homepage       = 'https://example.invalid/juyun'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'QuickLook', 'CryptoKit', 'Security'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
