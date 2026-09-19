# 安卓工程（Capacitor 6）

这个目录只放**我们自己写的**安卓原生代码。Capacitor 自动生成的图标、闪屏、gradle 包装器等没有放进仓库 —— 它们可以由 `npx cap add android` 重新生成，放进来只会让仓库变臃肿（gradle 分发包本身就有 100MB+）。

## 目录里有什么

| 文件 | 作用 |
|------|------|
| `app/src/main/java/com/luotianyi/run/MainActivity.java` | 入口 Activity，显式注册自定义插件 |
| `app/src/main/java/com/luotianyi/run/RunNotificationPlugin.java` | Capacitor 插件，JS 调 `show / update / hide / requestPermission` |
| `app/src/main/java/com/luotianyi/run/RunNotificationService.java` | 承载常驻通知的前台服务 |
| `app/src/main/java/com/luotianyi/run/RunNotificationReceiver.java` | 通知按钮的广播接收器 |
| `app/src/main/res/layout/notif_run.xml` | 通知条的自定义布局（RemoteViews） |
| `app/src/main/res/drawable/ic_notif.xml`、`ic_n_*.xml` | 通知条图标（vector drawable） |
| `app/src/main/res/values/colors.xml` | 通知条用到的颜色 |
| `app/src/main/AndroidManifest.xml` | 权限与组件声明 |

## 从零搭出可编译的工程

```bash
npm install
npm install @capacitor/cli @capacitor/core @capacitor/android
npm install @capacitor/app @capacitor/filesystem @capacitor-community/bluetooth-le
npx cap init "LuoTianyiRun" "com.luotianyi.run" --web-dir=www
npx cap add android
```

然后把本目录（`android/`）下的文件覆盖到生成的 `android/` 工程对应位置。

版本号在 `android/app/build.gradle`：

```groovy
defaultConfig {
    versionCode 2
    versionName "1.2"
}
```

改完：

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```

APK 在 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 几个容易踩的坑

**Android 14（targetSdk 34）的前台服务类型**

Manifest 里声明了 `android:foregroundServiceType="mediaPlayback"`，就必须把 type 传给 `startForeground()`：

```java
startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
```

用两参数的 `startForeground(id, n)` 会抛 `MissingForegroundServiceTypeException`。v1.2 之前就是栽在这里 —— 异常被 catch 后走 `NotificationManager.notify()` 兜底，而这行没包 try，没通知权限时直接 `SecurityException` 崩进程，表现就是「点击开始跑步后闪退」。

**Android 13+ 的通知是运行时权限**

只声明 `POST_NOTIFICATIONS` 没用，必须运行时申请。没拿到权限时**绝对不能调用 `notify()`**，否则抛 `SecurityException`。所有贴通知的入口都要先过 `canPost()` 检查。

**前台起不来时要主动收掉自己**

`startForeground()` 失败后不要留着服务，要 `stopSelf()` 并返回 `START_NOT_STICKY`。否则系统会在几秒后判定「调了 `startForegroundService()` 却没成功调用 `startForeground()`」直接杀掉 App。

**RemoteViews 的控件白名单**

自定义通知布局只能用系统允许的控件：LinearLayout / RelativeLayout / TextView / ImageView / ImageButton / Button 等。
**裸 `android.view.View` 不在白名单里**，用它做分隔线会让部分 ROM 的 inflate 失败、通知条整个出不来。这里用 `ImageView` 代替。

**通知按钮的图标**

`NotificationCompat.addAction()` 的图标在华为 / EMUI 等 ROM 上会渲染成文字按钮，出不来图标。想要图标按钮只能自定义 RemoteViews（本项目的做法），或者引入 `androidx.media` 的 MediaStyle —— 后者要多一个依赖，本项目没用。
