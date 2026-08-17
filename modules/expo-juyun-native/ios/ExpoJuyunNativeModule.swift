import CommonCrypto
import CryptoKit
import ExpoModulesCore
import QuickLook
import Security
import UIKit

private final class JuyunPreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(url: URL, title: String?) {
    previewItemURL = url
    previewItemTitle = title
  }
}

public final class ExpoJuyunNativeModule: Module, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private var previewItem: JuyunPreviewItem?
  private weak var activePreviewController: QLPreviewController?

  public func definition() -> ModuleDefinition {
    Name("ExpoJuyunNative")

    AsyncFunction("openPreview") { (uri: String, title: String?) in
      let url = try self.fileURL(uri)
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw GenericException("预览文件不存在")
      }
      let item = JuyunPreviewItem(url: url, title: title)
      guard QLPreviewController.canPreview(item) else {
        throw GenericException("iOS 暂不支持预览这种文件格式")
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        throw GenericException("无法打开 iOS 文件预览窗口")
      }
      guard self.activePreviewController == nil else {
        throw GenericException("系统预览窗口已经打开")
      }

      self.previewItem = item
      let controller = QLPreviewController()
      controller.dataSource = self
      controller.delegate = self
      self.activePreviewController = controller
      presenter.present(controller, animated: true)
    }
    .runOnQueue(.main)

    AsyncFunction("hashFile") { (uri: String, algorithm: String) in
      try self.hashFile(uri: uri, start: 0, length: nil, algorithm: algorithm)
    }

    AsyncFunction("hashRange") { (uri: String, start: Double, length: Double, algorithm: String) in
      let safeStart = try self.nonNegativeInteger(start, label: "哈希起点")
      let safeLength = try self.nonNegativeInteger(length, label: "哈希长度")
      try self.hashFile(
        uri: uri,
        start: safeStart,
        length: safeLength,
        algorithm: algorithm
      )
    }

    AsyncFunction("hashChunks") { (uri: String, chunkSize: Double, algorithm: String) in
      let safeChunkSize = try self.bufferSize(chunkSize, label: "哈希分片大小")
      try self.hashChunks(uri: uri, chunkSize: safeChunkSize, algorithm: algorithm)
    }

    AsyncFunction("gcidFile") { (uri: String, size: Double) in
      try self.gcid(uri: uri, size: self.nonNegativeInteger(size, label: "文件大小"))
    }

    AsyncFunction("hmac") {
      (message: String, key: String, algorithm: String, keyEncoding: String, outputEncoding: String) in
      try self.hmac(
        message: message,
        key: key,
        algorithm: algorithm,
        keyEncoding: keyEncoding,
        outputEncoding: outputEncoding
      )
    }

    AsyncFunction("aesEcbEncryptHex") { (message: String, key: String) in
      try self.aesEcbEncryptHex(message: message, key: key)
    }

    AsyncFunction("rsaEncryptBase64") { (message: String, publicKey: String) in
      try self.rsaEncryptBase64(message: message, publicKey: publicKey)
    }

    AsyncFunction("copyRange") {
      (sourceUri: String, destinationUri: String, start: Double, length: Double) in
      try self.copyRange(
        sourceUri: sourceUri,
        destinationUri: destinationUri,
        start: self.nonNegativeInteger(start, label: "复制起点"),
        length: self.nonNegativeInteger(length, label: "复制长度")
      )
    }

    AsyncFunction("readRangeBase64") { (uri: String, start: Double, length: Double) in
      let safeStart = try self.nonNegativeInteger(start, label: "读取起点")
      let safeLength = try self.bufferSize(length, label: "读取长度", allowZero: true)
      try self.readRange(uri: uri, start: safeStart, length: Int64(safeLength))
        .base64EncodedString()
    }
  }

  public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    previewItem == nil ? 0 : 1
  }

  public func previewController(
    _ controller: QLPreviewController,
    previewItemAt index: Int
  ) -> QLPreviewItem {
    previewItem!
  }

  public func previewControllerDidDismiss(_ controller: QLPreviewController) {
    if activePreviewController === controller {
      activePreviewController = nil
      previewItem = nil
    }
  }

  private func nonNegativeInteger(_ value: Double, label: String) throws -> Int64 {
    let maximumSafeInteger = 9_007_199_254_740_991.0
    guard value.isFinite,
          value >= 0,
          value <= maximumSafeInteger,
          value.rounded(.towardZero) == value else {
      throw GenericException("\(label)无效")
    }
    return Int64(value)
  }

  private func bufferSize(_ value: Double, label: String, allowZero: Bool = false) throws -> Int {
    let maximumBufferSize = 64 * 1024 * 1024
    guard value.isFinite,
          value.rounded(.towardZero) == value,
          value >= (allowZero ? 0 : 1),
          value <= Double(maximumBufferSize) else {
      throw GenericException("\(label)无效")
    }
    return Int(value)
  }

  private func fileURL(_ value: String) throws -> URL {
    guard !value.contains("\0") else {
      throw GenericException("无效的本地文件地址")
    }
    if let url = URL(string: value),
       url.isFileURL,
       (url.host == nil || url.host?.isEmpty == true),
       url.query == nil,
       url.fragment == nil,
       !url.path.contains("\0") {
      return url.standardizedFileURL
    }
    if value.hasPrefix("/") {
      return URL(fileURLWithPath: value).standardizedFileURL
    }
    throw GenericException("无效的本地文件地址")
  }

  private func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
  }

  private func eachChunk(
    url: URL,
    start: Int64,
    length: Int64?,
    chunkSize: Int = 1024 * 1024,
    consume: (Data) throws -> Void
  ) throws {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(start))
    var remaining = length

    while remaining == nil || remaining! > 0 {
      let requested = min(chunkSize, remaining.map { Int(min(Int64(chunkSize), $0)) } ?? chunkSize)
      guard requested > 0, let data = try handle.read(upToCount: requested), !data.isEmpty else {
        break
      }
      try consume(data)
      if let value = remaining {
        remaining = value - Int64(data.count)
      }
    }
    if let value = remaining, value > 0 {
      throw GenericException("本地文件长度不足，无法完成分片校验")
    }
  }

  private func hashFile(uri: String, start: Int64, length: Int64?, algorithm: String) throws -> String {
    let url = try fileURL(uri)
    switch algorithm.lowercased() {
    case "md5":
      var hasher = Insecure.MD5()
      try eachChunk(url: url, start: start, length: length) { hasher.update(data: $0) }
      return hex(hasher.finalize())
    case "sha1":
      var hasher = Insecure.SHA1()
      try eachChunk(url: url, start: start, length: length) { hasher.update(data: $0) }
      return hex(hasher.finalize())
    case "sha256":
      var hasher = SHA256()
      try eachChunk(url: url, start: start, length: length) { hasher.update(data: $0) }
      return hex(hasher.finalize())
    default:
      throw GenericException("不支持的哈希算法：\(algorithm)")
    }
  }

  private func hashChunks(uri: String, chunkSize: Int, algorithm: String) throws -> [String] {
    let url = try fileURL(uri)
    let normalizedAlgorithm = algorithm.lowercased()
    guard ["md5", "sha1", "sha256"].contains(normalizedAlgorithm) else {
      throw GenericException("不支持的哈希算法：\(algorithm)")
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var result: [String] = []

    while let data = try handle.read(upToCount: chunkSize), !data.isEmpty {
      switch normalizedAlgorithm {
      case "md5": result.append(hex(Insecure.MD5.hash(data: data)))
      case "sha1": result.append(hex(Insecure.SHA1.hash(data: data)))
      case "sha256": result.append(hex(SHA256.hash(data: data)))
      default: throw GenericException("不支持的哈希算法：\(algorithm)")
      }
    }
    return result
  }

  private func gcid(uri: String, size: Int64) throws -> String {
    var blockSize: Int64 = 0x40000
    while Double(size) / Double(blockSize) > 0x200 && blockSize < 0x200000 {
      blockSize <<= 1
    }
    let url = try fileURL(uri)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let actualSize = (attributes[.size] as? NSNumber)?.int64Value
    guard actualSize == size else {
      throw GenericException("本地文件在校验期间发生了变化，请重新选择")
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var outer = Insecure.SHA1()

    while let data = try handle.read(upToCount: Int(blockSize)), !data.isEmpty {
      outer.update(data: Data(Insecure.SHA1.hash(data: data)))
    }
    return hex(outer.finalize())
  }

  private func hmac(
    message: String,
    key: String,
    algorithm: String,
    keyEncoding: String,
    outputEncoding: String
  ) throws -> String {
    let keyData: Data
    switch keyEncoding.lowercased() {
    case "base64":
      guard let decoded = Data(base64Encoded: key) else {
        throw GenericException("HMAC 密钥不是有效的 Base64")
      }
      keyData = decoded
    case "utf8":
      keyData = Data(key.utf8)
    default:
      throw GenericException("不支持的 HMAC 密钥编码：\(keyEncoding)")
    }
    let symmetricKey = SymmetricKey(data: keyData)
    let messageData = Data(message.utf8)
    let output: Data

    switch algorithm.lowercased() {
    case "sha1": output = Data(HMAC<Insecure.SHA1>.authenticationCode(for: messageData, using: symmetricKey))
    case "sha256": output = Data(HMAC<SHA256>.authenticationCode(for: messageData, using: symmetricKey))
    default: throw GenericException("不支持的 HMAC 算法：\(algorithm)")
    }
    switch outputEncoding.lowercased() {
    case "base64": return output.base64EncodedString()
    case "hex": return hex(output)
    default: throw GenericException("不支持的 HMAC 输出编码：\(outputEncoding)")
    }
  }

  private func aesEcbEncryptHex(message: String, key: String) throws -> String {
    let keyData = Data(key.utf8)
    guard keyData.count == kCCKeySizeAES128 else {
      throw GenericException("AES 密钥必须是 16 字节")
    }
    let input = Data(message.utf8)
    var output = Data(count: input.count + kCCBlockSizeAES128)
    var outputLength: size_t = 0
    let status = output.withUnsafeMutableBytes { outputBytes in
      input.withUnsafeBytes { inputBytes in
        keyData.withUnsafeBytes { keyBytes in
          CCCrypt(
            CCOperation(kCCEncrypt),
            CCAlgorithm(kCCAlgorithmAES),
            CCOptions(kCCOptionPKCS7Padding | kCCOptionECBMode),
            keyBytes.baseAddress,
            kCCKeySizeAES128,
            nil,
            inputBytes.baseAddress,
            input.count,
            outputBytes.baseAddress,
            output.count,
            &outputLength
          )
        }
      }
    }
    guard status == kCCSuccess else {
      throw GenericException("AES 加密失败（\(status)）")
    }
    output.removeSubrange(outputLength..<output.count)
    return hex(output)
  }

  private func rsaEncryptBase64(message: String, publicKey: String) throws -> String {
    let cleaned = publicKey
      .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----BEGIN RSA PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----END RSA PUBLIC KEY-----", with: "")
      .components(separatedBy: .whitespacesAndNewlines)
      .joined()
    guard !cleaned.isEmpty, cleaned.utf8.count <= 16 * 1024 else {
      throw GenericException("天翼云盘返回的 RSA 公钥长度无效")
    }
    guard let decoded = Data(base64Encoded: cleaned) else {
      throw GenericException("天翼云盘返回的 RSA 公钥无效")
    }
    guard decoded.count <= 8 * 1024 else {
      throw GenericException("天翼云盘返回的 RSA 公钥过大")
    }
    let attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass: kSecAttrKeyClassPublic,
    ]
    var keyError: Unmanaged<CFError>?
    var key = SecKeyCreateWithData(decoded as CFData, attributes as CFDictionary, &keyError)
    if key == nil, let pkcs1 = extractPKCS1PublicKey(from: decoded) {
      keyError = nil
      key = SecKeyCreateWithData(pkcs1 as CFData, attributes as CFDictionary, &keyError)
    }
    guard let publicSecKey = key else {
      let reason = keyError?.takeRetainedValue().localizedDescription ?? "未知错误"
      throw GenericException("无法读取天翼 RSA 公钥：\(reason)")
    }
    guard SecKeyIsAlgorithmSupported(publicSecKey, .encrypt, .rsaEncryptionPKCS1) else {
      throw GenericException("当前 iOS 设备不支持 RSA PKCS#1 加密")
    }
    var encryptError: Unmanaged<CFError>?
    guard let encrypted = SecKeyCreateEncryptedData(
      publicSecKey,
      .rsaEncryptionPKCS1,
      Data(message.utf8) as CFData,
      &encryptError
    ) else {
      let reason = encryptError?.takeRetainedValue().localizedDescription ?? "未知错误"
      throw GenericException("RSA 加密失败：\(reason)")
    }
    return (encrypted as Data).base64EncodedString()
  }

  private func extractPKCS1PublicKey(from data: Data) -> Data? {
    let bytes = [UInt8](data)
    var index = 0
    guard readASN1Tag(0x30, bytes: bytes, index: &index) != nil else { return nil }
    guard let algorithmLength = readASN1Tag(0x30, bytes: bytes, index: &index) else { return nil }
    index += algorithmLength
    guard let bitStringLength = readASN1Tag(0x03, bytes: bytes, index: &index),
          bitStringLength > 1,
          index < bytes.count,
          bytes[index] == 0 else { return nil }
    index += 1
    let end = min(bytes.count, index + bitStringLength - 1)
    guard index < end else { return nil }
    return Data(bytes[index..<end])
  }

  private func readASN1Tag(_ expected: UInt8, bytes: [UInt8], index: inout Int) -> Int? {
    guard index < bytes.count, bytes[index] == expected else { return nil }
    index += 1
    guard index < bytes.count else { return nil }
    let first = Int(bytes[index])
    index += 1
    if first & 0x80 == 0 { return first }
    let count = first & 0x7f
    guard count > 0, count <= 4, index + count <= bytes.count else { return nil }
    var length = 0
    for _ in 0..<count {
      length = (length << 8) | Int(bytes[index])
      index += 1
    }
    guard index + length <= bytes.count else { return nil }
    return length
  }

  private func readRange(uri: String, start: Int64, length: Int64) throws -> Data {
    let url = try fileURL(uri)
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(start))
    let data = try handle.read(upToCount: Int(length)) ?? Data()
    guard data.count == Int(length) else {
      throw GenericException("本地文件长度不足，无法读取指定范围")
    }
    return data
  }

  private func copyRange(
    sourceUri: String,
    destinationUri: String,
    start: Int64,
    length: Int64
  ) throws {
    let source = try fileURL(sourceUri)
    let destination = try fileURL(destinationUri)
    guard source.path != destination.path else {
      throw GenericException("复制源文件与目标文件不能相同")
    }
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
      throw GenericException("无法创建临时上传分片")
    }
    let input = try FileHandle(forReadingFrom: source)
    let output = try FileHandle(forWritingTo: destination)
    defer {
      try? input.close()
      try? output.close()
    }
    try input.seek(toOffset: UInt64(start))
    var remaining = length
    while remaining > 0 {
      let requested = Int(min(Int64(1024 * 1024), remaining))
      guard let data = try input.read(upToCount: requested), !data.isEmpty else { break }
      try output.write(contentsOf: data)
      remaining -= Int64(data.count)
    }
    if remaining > 0 {
      try? FileManager.default.removeItem(at: destination)
      throw GenericException("本地文件长度不足，无法复制完整分片")
    }
  }
}
