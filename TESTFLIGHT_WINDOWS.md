# 在 Windows 11 上发布聚云到 TestFlight

这份流程不要求你拥有 Mac。EAS Build 在云端 macOS 机器上编译 iOS App，并把构建提交到 App Store Connect。

## 1. 开通与准备账号

1. 使用你的普通 Apple ID 加入 Apple Developer Program。
2. 在 Apple ID 设置中开启双重认证。
3. 等待会员状态显示为有效；未完成付费会员开通时无法向 App Store Connect 提交 iOS 构建。
4. 注册 Expo 账号，并在 Windows 安装 Node.js 22.13+ 与 Git。

不要把 Apple ID 密码、App 专用密码、恢复密钥或验证码发给任何人，也不要写进项目文件。

## 2. 本地检查源码

在 PowerShell 中解压项目并进入目录：

```powershell
npm install
npm run typecheck
npm test
npx expo config --type public
```

项目默认 Bundle ID 是 `com.lyricx001.juyun`。如果它已被其他开发者占用或你想换成自己的反向域名，在 `app.json` 中修改 `expo.ios.bundleIdentifier`，例如：

```json
"bundleIdentifier": "com.yourname.juyun"
```

Bundle ID 一旦用于 App Store Connect 正式记录，就尽量不要再改。

## 3. 登录 EAS 并配置项目

```powershell
npx eas-cli@latest login
npx eas-cli@latest whoami
npx eas-cli@latest build:configure
```

`build:configure` 如果询问平台，选择 iOS。首次云构建时按提示登录 Apple Developer。EAS 可以代管 Distribution Certificate 与 Provisioning Profile；对只有自己维护的项目，这是最省事的选择。

## 4. 创建并提交生产构建

```powershell
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

交互提示的处理原则：

- Apple Team：选择刚开通会员的个人 Team。
- Bundle Identifier：确认与 `app.json` 一致。
- Distribution Certificate / Provisioning Profile：选择让 EAS 创建或复用。
- App Store Connect App：首次可按引导创建；名称可用“聚云”，SKU 可用 `juyun-ios-001`。
- 出口合规：项目声明只使用系统提供的标准加密能力，`usesNonExemptEncryption` 已设为 `false`。

如果自动提交没有完成，可在构建成功后运行：

```powershell
npx eas-cli@latest submit --platform ios --profile production
```

## 5. 在 App Store Connect 启用 TestFlight

1. 登录 App Store Connect，打开“我的 App”中的聚云。
2. 进入 TestFlight，等待新构建从“正在处理”变为可测试。
3. 填写系统要求的测试信息、出口合规或内容说明。
4. 在“内部测试”创建一个组，把自己的 Apple ID 添加为内部测试员，再选择刚上传的构建。
5. 在 iPhone 的 TestFlight App 中接受邀请并安装。

只给自己使用时，用内部测试即可，不需要公开测试链接，也通常不需要外部测试的 Beta App Review。

## 6. 首次真机验收

按下面顺序逐家检查，先用小文件，避免会员限速或大文件掩盖问题：

1. 添加账号，点击“保存并测试连接”；115、夸克或天翼的可选根目录 ID 留空时，应正常进入默认根目录。
2. 打开两层文件夹并返回；测试当前筛选、排序和多选。115、百度、阿里再测试一次“全盘”搜索。
3. 分别预览一个 MP4、MP3、JPG、PDF 和 DOCX；视频测试倍速、全屏和画中画，文档应打开 iOS Quick Look。文档准备过程中返回并立即再次打开同一文件，不能出现缓存损坏或被旧任务删除。
4. 新建一个测试文件夹，上传一个小文件，再依次测试重命名、复制、移动和删除。夸克开放接口没有复制按钮，这是预期行为。
5. 下载一个较大的测试文件，暂停后等待几秒，确认迟到的系统进度不会把状态改回“下载中”；彻底关闭 App，重新打开“传输”页并继续下载，再测试完成后的预览与系统分享。
6. 在“传输”页对已完成任务分别测试“移除记录”和“删除文件”：前者应保留本机文件，后者应删除本机文件；两者都不得删除网盘原文件。再点击“清理记录”，确认完成/失败历史被清除，但系统“文件”中的已下载文件和网盘原文件仍存在。
7. 对同一任务快速连续点暂停/继续，确认按钮只执行一次；再取消任务，确认任务不会重新出现或错误完成。下载中人为断网或截断响应，确认不完整文件不会显示为完成，并在系统“文件”的聚云 `Downloads` 中确认失败或取消的半成品已被清理。
8. 为同一账号建立排队、下载中和暂停任务后删除该账号，确认三类任务都停止、半成品被清理，其他账号的任务不受影响。
9. 编辑一个已连接账号，故意填错 Token 并测试失败；返回后确认原凭证仍可连接，再保存正确凭证。
10. 完全退出后重新打开，确认账号仍在且凭证无需重填。
11. 在百度网盘中选中文件后把移动或复制目标选为原文件夹，App 应提示“无需移动”或“无法复制”，且刷新后文件不应出现重复或丢失。
12. 对同一个下载快速执行“暂停 → 继续 → 取消”，然后立刻重新下载同名文件；新任务不能被旧任务的迟到回调改成失败，最终文件也不能被删除或截断。
13. 用超过 512 MB 的 PDF、Office 或压缩包测试系统预览，应直接提示改用“下载到本机”，不能持续占满预览缓存；视频和音频仍使用流式播放器，不受这个 Quick Look 临时文件上限影响。
14. 完成一个已知大小的下载并彻底退出 App；在 iOS“文件”中用同名但大小不同的文件替换它，再打开“传输”页。任务应改为失败并清理被替换的文件，不能继续预览或分享。
15. 在天翼云盘准备超过 60 项的目录并连续向下检查，确认不足 60 项的中间页不会让列表提前结束；最终数量应与天翼客户端一致，也不能出现重复项。
16. 上传一个校验耗时较长的文件，并在“正在校验文件”阶段从原位置替换或修改源文件；聚云应在创建网盘上传任务前提示文件已变化，不能错误秒传或上传校验值不一致的内容。

把失败时 App 显示的网盘名称、HTTP 状态、服务商错误码和操作步骤记下来，但不要截取或复制 Token/Cookie。

## 7. 发布后更新

代码修改并通过检查后，再运行同一条生产构建命令：

```powershell
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

`eas.json` 已启用生产构建号自动递增。每个 TestFlight 构建有测试有效期，临近过期或凭证接口变化时重新构建即可。

## 常见问题

### 提示 Apple Developer Program membership required

付费会员尚未生效、当前 Apple ID 不在正确 Team，或 App Store Connect 协议未接受。回到 Apple Developer 与 App Store Connect 检查会员、协议和税务/联系信息状态。

### Bundle Identifier not available

`com.lyricx001.juyun` 已被占用。改成只属于你的 Bundle ID，并重新运行构建配置。

### 构建成功但 TestFlight 看不到

先确认 EAS 的 submit 阶段成功，再等待 App Store Connect 处理。若提交失败，单独运行 `eas submit`，根据日志处理协议、权限或 App 记录不匹配问题。

### App 打开网盘时报 401 / 未登录

Token 或 Cookie 已过期。编辑对应账号并重新粘贴；夸克和天翼尤其可能需要手动更新，迅雷也可能触发设备或验证码校验。

### 视频能下载但不能播放

可能是编码格式不受 iOS 原生播放器支持、CDN 要求的 Header 发生变化，或直链已经过期。先返回文件列表重新打开；再用 MP4/H.264 小样本排除编码问题。

### Expo Go 提示缺少原生文件组件

这是预期现象。聚云 v1.11 的文档预览、流式文件校验和天翼分片上传包含本地 iOS 模块，必须使用 EAS development build 或 TestFlight 构建，不能用通用 Expo Go 验收这些功能。
