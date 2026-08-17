# 在 Windows 上免费自签安装聚云

这套流程不需要 TestFlight、Mac、Expo 账号或付费 Apple Developer Program。GitHub Actions 只负责在云端 Mac 上把源码编译成**未签名 IPA**；Sideloadly 再使用你的普通 Apple 账号，把 IPA 签名并安装到自己的 iPhone 或 iPad。

> 免费 Apple 账号的签名有效期为 7 天，同一设备最多同时安装 3 个免费自签 App。Sideloadly 可以在电脑开机且手机能通过 USB 或同一 Wi-Fi 被发现时自动续签。

## 需要准备

- Windows 10 或 Windows 11 电脑。
- iPhone 或 iPad、数据线和一个普通 Apple 账号。
- 官网独立安装版 iTunes、官网独立安装版 iCloud、Sideloadly 64 位版。
- 一个 GitHub 账号。仓库建议设为 Private；项目中不得加入任何网盘 Token、Cookie、账号或密码。

Sideloadly 在 Windows 上要求官网独立安装版 iTunes 和 iCloud。如果以前安装的是 Microsoft Store 版本，应先卸载商店版，再安装 Sideloadly 官网给出的 Apple 下载版本。

## 第一步：在 GitHub 生成未签名 IPA

1. 把 `Juyun-iOS-v1.11.0-selfsign-source.zip` 解压到一个新文件夹。
2. 在 GitHub 新建一个 Private 仓库，例如 `Juyun-iOS`。
3. 把解压文件夹**里面的全部内容**上传到仓库根目录。上传完成后，仓库首页应直接看到 `package.json`、`app.json`、`src` 和 `.github`；不要在仓库里再套一层文件夹。
4. 打开仓库顶部的 **Actions**。
5. 在左侧选择 **生成聚云自签 IPA**，点击 **Run workflow**，再次点击绿色的 **Run workflow**。
6. 等待构建变成绿色对勾。首次编译通常需要一段时间，不要关闭或取消运行。
7. 打开这次运行，在页面底部的 **Artifacts** 下载 `Juyun-iOS-v1.11.0-unsigned`。
8. 解压下载的 Artifact，得到：
   - `Juyun-unsigned.ipa`：交给 Sideloadly 安装。
   - `Juyun-unsigned.ipa.sha256`：文件校验值，可留作核对。

GitHub 构建流程不会索取或保存 Apple 账号、Apple 密码、验证码、证书或设备 UDID。生成的 IPA 没有 Apple 签名，不能直接点击安装，也不能上传 App Store。

## 第二步：让 Windows 识别 iPhone

1. 安装官网独立版 iTunes、官网独立版 iCloud 和 Sideloadly，然后重启 Windows。
2. 用数据线连接 iPhone 或 iPad，解锁设备。
3. 手机上出现“要信任此电脑吗”时选择 **信任**，输入设备锁屏密码。
4. 打开 iTunes，确认左上方能看到设备图标。
5. 如需自动无线续签，在 iTunes 的设备摘要页勾选 **通过 Wi-Fi 与此 iPhone 同步**，然后点 **应用/同步**。手机和电脑以后需要连接同一个局域网。

## 第三步：使用 Sideloadly 自签安装

1. 打开 Sideloadly，顶部 `iDevice` 选择自己的 iPhone 或 iPad。
2. 把 `Juyun-unsigned.ipa` 拖到左侧 IPA 图标区域。
3. 在 `Apple account` 中填写用于自签的 Apple 账号。可以使用普通免费账号，不需要付费开发者会员。不要把密码或六位验证码发送给任何人。
4. 保持默认安装模式，勾选自动刷新选项，然后点击 **Start**。
5. 根据 Apple 登录窗口完成密码和双重认证。等待状态显示安装完成。
6. iOS 16 及以上进入 **设置 → 隐私与安全性 → 开发者模式**，打开后按提示重启设备。
7. 如果打开聚云时显示“不受信任的开发者”，进入 **设置 → 通用 → VPN 与设备管理**，选择自签所用 Apple 账号并点 **信任**。
8. 保持设备联网，重新打开聚云。

## 七天续签与数据保护

- 不要删除聚云。续签或更新时继续使用同一个 Apple 账号和同一个 Bundle ID：`com.lyricx001.juyun`。
- 保持 Sideloadly 后台自动刷新服务运行。电脑和手机通过 USB 连接，或已启用 iTunes Wi-Fi 同步且处于同一网络时，Sideloadly 会尝试在到期前刷新。
- 如果电脑连续关闭超过 7 天导致聚云无法打开，重新连接设备，把同一个 IPA 用相同账号覆盖安装即可。
- 覆盖安装通常会保留 App 数据；主动卸载 App 会删除其 Keychain 之外的本机数据，因此不要先卸载再安装。
- 每次更新聚云都应沿用同一 Bundle ID，否则 iOS 会把它当作另一个 App。

## 常见问题

### Sideloadly 看不到设备

确认手机已解锁并信任电脑；打开 iTunes检查能否识别。如果仍然看不到，重新安装 Sideloadly 官网提供的独立版 iTunes 和 iCloud，重启电脑并更换 USB 接口或数据线。

### 提示 Developer Mode Required

进入 **设置 → 隐私与安全性 → 开发者模式**。打开后 iPhone 会重启，解锁时再次确认启用。

### 提示 Untrusted Developer

进入 **设置 → 通用 → VPN 与设备管理**，选择对应 Apple 账号并信任。

### 提示账号协议未接受

用同一个 Apple 账号登录 `https://developer.apple.com/account/`，只接受免费的 Apple Developer Agreement；不需要购买会员，然后重新自签。

### 七天后 App 无法打开

免费签名已过期。不要卸载聚云，打开 Sideloadly 并用相同 Apple 账号、相同 IPA 覆盖安装；同时检查自动刷新服务、iTunes Wi-Fi 同步和电脑防火墙。

### GitHub 构建失败

打开失败的 Actions 运行，点进红色步骤查看日志。不要截图或提交含有 Apple 密码、验证码、网盘 Token 或 Cookie 的内容。本流程在 `macos-26` 上构建，因为 Expo SDK 57 要求 Xcode 26.4 或更新版本。
