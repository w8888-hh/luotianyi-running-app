# 哔哩哔哩音乐源

为「洛天依陪跑」增加哔哩哔哩作为音乐来源：扫码登录后浏览收藏夹、搜索视频，并播放视频里的**真实音频**（不是后台视频）。

## 目录

| 文件 | 内容 |
|------|------|
| [README.md](README.md) | 功能说明、使用方式、构建方法（本文件） |
| [DESIGN.md](DESIGN.md) | 架构、接口、数据流与关键取舍 |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 逐文件改动说明与代码位置 |
| [PITFALLS.md](PITFALLS.md) | 实机调试中踩到的坑与最终结论 |

## 功能

- **扫码登录**：App 内直接展示二维码，用哔哩哔哩 App 扫码并在手机确认，无需粘贴 Cookie。
- **收藏夹浏览**：读取当前账号创建的全部收藏夹，分页查看收藏内容。
- **视频搜索**：按关键词搜索 B 站视频，支持分页加载。
- **加入播放列表**：勾选后「加入播放列表」或「载入并播放」，与本地音乐、内置音乐混排。
- **真实音频播放**：解析视频的渐进式媒体流，由 Android 原生 Media3/ExoPlayer 播放，只出声、不放画面。
- **锁屏控制**：原生 `MediaSession`，支持通知栏/耳机/锁屏的播放、暂停、seek。
- **歌单持久化**：B 站曲目只保存 `bvid`/`cid` 等元数据，短时效播放地址每次播放时重新解析。

## 使用

1. 打开 App → 「音乐」→ 「哔哩哔哩」
2. 点「扫码登录」，用哔哩哔哩 App 扫码并确认
3. 在收藏夹中点开任意收藏夹，或直接用搜索框搜索
4. 勾选条目 → 「加入播放列表」或「载入并播放」

Cookie 仍可通过「其他方式：粘贴 Cookie」手动填写，作为备用登录。

## 构建

前置：Node 18+、JDK 17、Android SDK（platform 34）。

```bash
npm install
npm run build:www        # 根目录 index.html / core / assets / voices → www/
npx cap sync android
cd android && ./gradlew assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

## 免责声明

本项目使用哔哩哔哩公开的 Web/TV 接口读取**当前登录账号自己可见**的收藏夹与视频。请仅在个人学习与自用范围内使用，遵守哔哩哔哩用户协议；不提供下载、去水印、DRM 解密或访问控制绕过能力。
