# 设计说明

## 为什么需要原生层

README 里原本的架构是「Capacitor 套壳 + WebView 播放」，音乐由 HTML `Audio` 承担。这个架构对 B 站音频有两个硬伤：

1. **不能带鉴权头**：B 站媒体 CDN 要求 `Referer: https://www.bilibili.com/`，HTML `Audio` 无法设置请求头。
2. **拿不到有效地址**：`playurl` 需要登录 Cookie 与签名，且必须在原生侧发起（WebView 的 `fetch` 受 CORS 限制，页面源是 `https://localhost`）。

因此新增两层原生能力：**接口客户端** 和 **播放服务**。

## 组件

```
┌──────────────────────────── WebView ────────────────────────────┐
│  index.html                                                     │
│    ├─ 哔哩哔哩页：登录 / 收藏夹 / 搜索 / 勾选导入                 │
│    └─ core/engine.js  MusicPlayer                               │
│         └─ track.source === 'bilibili' → 走原生播放              │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Capacitor Plugin "BiliSource"
┌──────────────────────────────┴──────────────────────────────────┐
│  BiliSourcePlugin   方法：startQrLogin / pollQrLogin /          │
│                           listFavFolders / listFavItems /       │
│                           searchVideo / resolveAudio /          │
│                           playAudio / pauseAudio / seekAudio …  │
│  BiliHttpClient     Cookie 持久化、WBI 签名、TV 签名、HTTP        │
│  BiliWbiSigner      WBI mixin key 与 MD5                         │
│  BiliMediaService   ExoPlayer + MediaSession 前台服务            │
└─────────────────────────────────────────────────────────────────┘
```

## 关键接口

| 用途 | 接口 | 备注 |
|------|------|------|
| 二维码生成 | `POST passport.bilibili.com/x/passport-tv-login/qrcode/auth_code` | TV 端，`appkey=4409e2ce8ffd12b8` |
| 二维码轮询 | `POST .../qrcode/poll` | 返回 `cookie_info.cookies` |
| 账号校验 | `GET api.bilibili.com/x/web-interface/nav` | 必须 `isLogin=true` 且 `mid>0` |
| 收藏夹列表 | `GET /x/v3/fav/folder/created/list-all` | **不传分页参数** |
| 收藏夹内容 | `GET /x/v3/fav/resource/list` | `ps ≤ 40` |
| 视频搜索 | `GET /x/web-interface/search/type` | 非 WBI 版本，规避风控 |
| 取流 | `GET /x/player/wbi/playurl` | `fnval=1` 渐进式，需 WBI 签名 |

## 音频取流为什么用 `fnval=1`

`fnval=4048` 返回 DASH：音频是独立的 `dash.audio[].baseUrl` 分片，需要初始化段和专门的分片处理，直接交给播放器会失败。

`fnval=1` 返回**渐进式单段媒体**，`durl[0].url` 可直接播放：

```json
{
  "code": 0,
  "data": {
    "format": "mp4720",
    "durl": [{ "url": "https://...", "size": 51973319, "length": 213000 }]
  }
}
```

实现上还做了三点保护：

- 只接受单段 `durl`；多段会截断播放，降级重试。
- 失败时降 `qn=32` 再试一次。
- 支持 `backup_url` 备用地址。

## 登录态

- 二维码票据 `auth_code` **只存在原生内存**，不返回 WebView、不写日志。
- Cookie 存 `SharedPreferences`（应用私有）。
- 扫码成功后先临时写入 Cookie，`nav` 校验通过才提交；失败回滚旧 Cookie。

## 播放链路

```
MusicPlayer._playIndex(i)
  └─ track.source === 'bilibili'
       ├─ BiliSource.resolveAudio({ bvid, cid })   → 渐进式 URL
       └─ BiliSource.playAudio({ url, title })     → BiliMediaService
                                                      └─ ExoPlayer + MediaSession
```

本地音乐与内置音乐仍然走原来的 HTML `Audio`，两条链路互不影响。

## 数据持久化

歌单（`PlaylistStore`）中 B 站曲目只存：

```json
{ "name": "...", "source": "bilibili", "url": "",
  "providerMeta": { "bvid": "BV...", "aid": 0, "cid": 0, "author": "...", "cover": "..." } }
```

不存 `url`，因为播放地址是短时效签名 URL，过期后重新解析。
