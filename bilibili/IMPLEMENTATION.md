# 改动说明

## 新增文件

### `android/.../BiliWbiSigner.java`

WBI 参数签名。

- `MIXIN_KEY_ENC_TAB`：PiliPlus 使用的置换表。
- `mixinKey(imgKey, subKey)`：从 `/x/web-interface/nav` 的 `wbi_img` 拼出 32 位 mixin key。
- `encode()`：按 B 站规范 percent-encode，`! ' ( ) *` 保持编码态。
- `signedQuery()`：排序 → 编码 → `md5(query + mixinKey)`。

### `android/.../BiliHttpClient.java`

HTTP 与会话管理。

| 方法 | 说明 |
|------|------|
| `get / postPassport` | 带 Cookie、UA、Referer 的请求，统一错误码 |
| `getCookie / setCookie / clearCookie` | `SharedPreferences` 持久化，读取时与 session cookie 合并 |
| `qrCreate / qrPoll` | TV 二维码，签名只覆盖 `appkey/local_id/ts(/auth_code)` |
| `cookiesFromQr` | 从 `data.cookie_info.cookies` 提取 |
| `absorbSetCookies / sessionCookieHeader` | 吸收响应 `Set-Cookie` |
| `ensureBuvid` | 搜索风控所需的 `buvid3` |
| `nav` | 刷新 WBI key + 账号校验 |
| `signedGet` | WBI 签名请求，无 key 时降级为普通请求 |
| `isLoggedIn` | 严格判断 `isLogin && mid>0` |

### `android/.../BiliSourcePlugin.java`

Capacitor 插件 `BiliSource`。

| 方法 | 说明 |
|------|------|
| `startQrLogin` | 生成二维码，ZXing 编码为 PNG data URL |
| `pollQrLogin` | 单次轮询；`waiting / scanned / verified / expired` |
| `cancelQrLogin` | 作废当前票据 |
| `getAccount / setCookie / clearCookie` | 账号与备用 Cookie 登录 |
| `listFavFolders` | 收藏夹列表 |
| `listFavItems` | 收藏夹内容，`ps ≤ 40` |
| `searchVideo` | 关键词搜索，非 WBI 接口 |
| `resolveAudio` | 解析渐进式媒体地址 |
| `playAudio / pauseAudio / resumeAudio / seekAudio / stopAudio` | 媒体控制 |

### `android/.../BiliMediaService.java`

- `MediaSessionService` + `ExoPlayer`。
- 默认请求头 `Referer: https://www.bilibili.com/` 与桌面 UA。
- 通过 `BiliSourcePlugin.dispatchMediaState/dispatchMediaError` 回传状态。

## 修改文件

### `android/app/src/main/java/com/luotianyi/run/MainActivity.java`

```java
registerPlugin(BiliSourcePlugin.class);
```

### `android/app/src/main/AndroidManifest.xml`

新增前台媒体服务声明：

```xml
<service
    android:name=".BiliMediaService"
    android:exported="true"
    android:foregroundServiceType="mediaPlayback"
    android:stopWithTask="false">
    <intent-filter>
        <action android:name="androidx.media3.session.MediaSessionService" />
    </intent-filter>
</service>
```

### `core/engine.js`

- `_mkTrack()` 增加 `source` / `providerMeta` 字段。
- 新增 `addProviderTracks(items)`：按 `bvid` 去重追加。
- `loadUrls()` 支持带 `source` 的条目。
- `_playIndex()` 对 `source === 'bilibili'` 走原生解析与播放。
- `pause()` / `stop()` 对 B 站曲目转发到原生服务。
- `PlaylistStore.add()` 保存 provider 元数据、不保存短时效 URL。
- HTML `Audio` 增加 `onerror`，输出媒体错误码便于定位。

### `index.html`

- 音乐浮层新增「哔哩哔哩」标签。
- 未登录：二维码区域、扫码按钮、Cookie 备用入口。
- 已登录：账号信息、搜索框、收藏夹列表。
- 收藏夹详情与搜索结果：复选框 + 「加入播放列表」/「载入并播放」。
- 轮询状态分别显示「等待扫码」「已扫码，请在手机上确认」「登录成功」。

## 未改动的部分

- 本地音乐导入与播放逻辑。
- 内置音乐（`assets/music_meta.json`）。
- 跑步状态通知条（`RunNotification`）。
- 心率、GPS、节拍器。
