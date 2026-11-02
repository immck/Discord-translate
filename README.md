# Discord 翻译插件

Chrome / Edge Manifest V3 扩展，当前版本 1.2.0。

## 安装

1. 下载本仓库 ZIP 并解压，或使用 Git 克隆仓库。
2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择包含 manifest.json 的本项目根目录。
5. 刷新已经打开的 Discord 或其他网页。

## 使用

- Discord 消息：悬停消息后点击翻译按钮，或启用消息右键翻译。
- Discord 输入框：使用输入框翻译按钮将输入翻译成英文。
- 其他网页：选中文字后使用浏览器右键菜单“翻译此处为中文”；也支持获取右键附近的文字。
- 点击扩展图标修改开关、自动翻译、缓存和紧凑显示，点击 Save 保存。
- Rescan visible messages 用于重新扫描并翻译 Discord 当前可见消息。

当前消息翻译和网页右键翻译固定使用简体中文；输入框翻译默认英文。弹窗中的 Target language 字段尚未完整接入消息翻译流程。

## 翻译服务与数据

后台依次尝试 Google、Google Web、配置后的 Microsoft / DeepL、Microsoft Edge 和 MyMemory。无需先填写密钥即可尝试默认服务；网络限制、限流或第三方接口变化可能导致失败，不保证免费接口长期可用。

Microsoft Key、Region 和 DeepL Key 可选，在弹窗保存。密钥、设置和翻译缓存存储于浏览器扩展本地存储中，密钥未加密；请勿把密钥写入源码或提交仓库。

翻译文字会发送给所使用的第三方翻译服务；自动翻译默认关闭。扩展需要网页访问权限以提供网页右键翻译。

## 文件

- manifest.json：安装清单和权限。
- background.js：右键菜单和翻译服务请求。
- content.js：Discord 消息与输入框翻译。
- page-bridge.js：Discord 编辑器交互。
- generic-content.js：网页右键文字提取和结果展示。
- popup.html / popup.js：设置界面。

此仓库仅包含 Discord / 网页翻译扩展，不包含 X Space 字幕工具。
