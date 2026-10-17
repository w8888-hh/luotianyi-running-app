# 踩坑记录

以下都是真机（Redmi K20 Pro / 荣耀 TNA-AN00）实际调试中遇到的问题，按现象 → 原因 → 结论整理，方便后来者少走弯路。

## 1. 二维码能生成，但扫码后 App 没反应

**现象**：二维码正常显示，手机扫码也提示登录，但 App 一直停在未登录。

**原因**：`pollQrLogin()` 校验票据后，传给 `qrPoll()` 的是请求参数里的 `authCode`（前端不传，为空），而不是插件内部保存的 `qrAuthCode`。服务端每次收到空 `auth_code` 都返回：

```json
{"code": -400, "message": "请求错误"}
```

**结论**：票据必须用服务端绑定值。修正为：

```java
final String authCode;
synchronized (qrLock) {
    if (qrAuthCode == null) { call.reject("QR_INVALID"); return; }
    authCode = qrAuthCode;
}
client.qrPoll(authCode, ...);
```

## 2. TV 扫码凭据不能混用

**现象**：用某组 `appkey/appsec` 能生成二维码，但登录态始终拿不到。

**原因**：哔哩哔哩有多套客户端凭据，TV 端与移动端/HD 端不通用。

**结论**：TV 二维码使用：

```text
appkey = 4409e2ce8ffd12b8
appsec = 59b43e04ad6965f34319062b478f83dd
```

并且签名只覆盖 `appkey`、`local_id`、`ts`（轮询再加 `auth_code`），**`appsec` 不随表单发送**：

```java
md5("appkey=...&local_id=0&ts=..." + appsec)
```

## 3. 收藏夹打不开（返回空列表）

**现象**：登录成功，但收藏夹列表为空。

**原因**：`/x/v3/fav/folder/created/list-all` **不接受 `pn`/`ps` 分页参数**，传了会导致返回异常；另外该接口在未登录时返回 `code:0` 且 `data:null`，不报错。旧代码把 `null` 当成「没有收藏夹」。

**结论**：

- 只传 `up_mid`。
- `data:null` 明确判定为登录失效。
- `/x/v3/fav/resource/list` 的 `ps` 上限是 **40**，不是 50。

修正后真机返回 41 个收藏夹。

## 4. 取流固定返回 `-400`

**现象**：登录正常，但 `/x/player/wbi/playurl` 总是：

```json
{"code": -400, "message": "请求错误"}
```

**原因**：WBI 签名算错。原实现先把参数拼成字符串，再 URL 解码后重组，破坏了签名原文。

**结论**：签名必须一次性构建规范查询串：

```java
TreeMap 排序 → percent-encode → md5(canonical + mixinKey)
```

且编码要保留 `! ' ( ) *` 的百分号形式：

```java
URLEncoder.encode(v, "UTF-8")
    .replace("+", "%20")
    .replace("!", "%21").replace("'", "%27")
    .replace("(", "%28").replace(")", "%29")
    .replace("*", "%2A");
```

## 5. 取到音频地址但放不出声

**现象**：`resolveAudio` 返回 URL，播放器无声音或报错。

**原因**：用的是 DASH 音频分片（`fnval=4048` → `dash.audio[].baseUrl`），需要初始化段和分片处理。

**结论**：改用渐进式流：

```text
fnval=1 → data.durl[0].url
```

返回单段 `mp4`（如 `format=mp4720`），可直接播放。实现上还应：

- 只接受单段 `durl`（多段会截断）。
- 失败降 `qn=32` 重试。
- 支持 `backup_url`。

## 6. CDN 拒绝请求

**现象**：URL 正确但 ExoPlayer 报 403/400。

**原因**：哔哩哔哩 CDN 校验 `Referer` 与 `User-Agent`。

**结论**：给 ExoPlayer 配置默认请求头：

```java
new DefaultHttpDataSource.Factory()
    .setUserAgent("Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36")
    .setDefaultRequestProperties(Map.of("Referer", "https://www.bilibili.com/"));
```

## 7. 搜索只返回 `v_voucher`

**现象**：搜索接口返回：

```json
{"code": 0, "data": {"v_voucher": "..."}}
```

**原因**：`/x/web-interface/wbi/search/type` 对第三方客户端有风控，即使带 WBI 签名和登录 Cookie 也会被拦。

**结论**：改用非 WBI 的：

```text
GET /x/web-interface/search/type?search_type=video&keyword=...&page=...&page_size=20
```

同时补 `buvid3`（`/x/frontend/finger/spi` 返回的 `b_3`），否则仍可能被拦。

## 8. 失效 Cookie 让匿名请求也失败

**现象**：公开视频解析返回 `AUTH_EXPIRED`。

**原因**：携带了过期 Cookie，服务端把它判成登录失效。

**结论**：`resolveAudio` 不强制登录；请求遇到 `-101/-400` 且有 Cookie 时，去掉 Cookie 重试一次。

## 9. WebView 侧无法直接请求接口

**现象**：在页面里 `fetch('https://api.bilibili.com/...')` 报 `Failed to fetch`。

**原因**：页面源是 `https://localhost`，跨域被 CORS 拦。

**结论**：所有 B 站接口请求都放在原生插件中，WebView 只调用 Capacitor 方法。
