package com.luotianyi.run;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * 承载常驻通知的前台服务。
 * 前台服务起不来时（Android 12+ 后台启动限制等）会退回 NotificationManager 的普通通知，
 * 保证「通知条」这个能力本身不丢。
 */
public class RunNotificationService extends Service {

    static final String CHANNEL_ID = "run_status";
    static final int NOTIF_ID = 20260;

    static final String ACTION_START = "com.luotianyi.run.notify.START";
    static final String ACTION_UPDATE = "com.luotianyi.run.notify.UPDATE";
    static final String ACTION_HIDE = "com.luotianyi.run.notify.HIDE";

    static final String EXTRA_TITLE = "t";
    static final String EXTRA_TEXT = "x";
    static final String EXTRA_BIG = "b";
    static final String EXTRA_TRACK = "k";
    static final String EXTRA_WORKOUT = "w";
    static final String EXTRA_PLAYING = "p";
    static final String EXTRA_RUNNING = "r";
    static final String EXTRA_PAUSED = "u";

    public static class Data {
        String title = "洛天依陪跑";
        String text = "";
        String bigText = "";
        String track = "";
        String workout = "";
        boolean playing = false;
        boolean running = false;
        boolean paused = false;
    }

    static void applyIntent(Intent i, Data d) {
        i.putExtra(EXTRA_TITLE, d.title);
        i.putExtra(EXTRA_TEXT, d.text);
        i.putExtra(EXTRA_BIG, d.bigText);
        i.putExtra(EXTRA_TRACK, d.track);
        i.putExtra(EXTRA_WORKOUT, d.workout);
        i.putExtra(EXTRA_PLAYING, d.playing);
        i.putExtra(EXTRA_RUNNING, d.running);
        i.putExtra(EXTRA_PAUSED, d.paused);
    }

    static Data fromIntent(Intent i) {
        Data d = new Data();
        if (i == null) return d;
        if (i.hasExtra(EXTRA_TITLE)) d.title = i.getStringExtra(EXTRA_TITLE);
        if (i.hasExtra(EXTRA_TEXT)) d.text = i.getStringExtra(EXTRA_TEXT);
        if (i.hasExtra(EXTRA_BIG)) d.bigText = i.getStringExtra(EXTRA_BIG);
        if (i.hasExtra(EXTRA_TRACK)) d.track = i.getStringExtra(EXTRA_TRACK);
        if (i.hasExtra(EXTRA_WORKOUT)) d.workout = i.getStringExtra(EXTRA_WORKOUT);
        d.playing = i.getBooleanExtra(EXTRA_PLAYING, false);
        d.running = i.getBooleanExtra(EXTRA_RUNNING, false);
        d.paused = i.getBooleanExtra(EXTRA_PAUSED, false);
        return d;
    }

    private static volatile Data last = new Data();

    /**
     * Android 13+ 的通知是运行时权限。没授权就去 notify() 会抛 SecurityException，
     * 从 onStartCommand 里抛出去就是整进程崩溃 —— 所有贴通知的入口都必须先过这一关。
     */
    static boolean canPost(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 整个入口做兜底：通知是锦上添花，绝不因为它把 App 带崩
        try {
            String action = (intent == null) ? null : intent.getAction();
            if (ACTION_HIDE.equals(action)) {
                cancel(this);
                stopForegroundCompat();
                stopSelf();
                return START_NOT_STICKY;
            }
            Data d = fromIntent(intent);
            if (d.title != null || d.text != null) last = d;

            if (!canPost(this)) {
                // 没权限就不贴，也别把自己留在「已 start 但没 startForeground」的非法状态
                stopForegroundCompat();
                stopSelf();
                return START_NOT_STICKY;
            }

            Notification n = build(this, last);
            boolean fg = false;
            try {
                // Android 14(targetSdk 34) 强制要求：Manifest 里声明了 foregroundServiceType，
                // 就必须把 type 传给 startForeground，否则抛 MissingForegroundServiceTypeException。
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                } else {
                    startForeground(NOTIF_ID, n);
                }
                fg = true;
            } catch (Throwable t) {
                fg = false;
            }

            if (!fg) {
                // 拿不到前台资格就退回普通通知；notify 本身也必须吞掉异常
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.notify(NOTIF_ID, n);
                } catch (Throwable t) {
                    // 没权限 / 被系统拦，直接放弃，绝不外抛
                }
                // 关键：既然前台没起来，就立刻收掉自己并声明不重建，
                // 否则系统会判定「startForegroundService 后未调用 startForeground」几秒后杀进程。
                stopForegroundCompat();
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_STICKY;
        } catch (Throwable t) {
            return START_NOT_STICKY;
        }
    }

    private void stopForegroundCompat() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
        } catch (Throwable t) {
            // ignore
        }
    }

    static void postOnly(Context ctx, Data d) {
        if (ctx == null) return;
        if (!canPost(ctx)) return;              // 没权限就别贴，SecurityException 会直接崩
        try {
            createChannel(ctx);
            last = d;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, build(ctx, d));
        } catch (Throwable t) {
            // ignore
        }
    }

    static void cancel(Context ctx) {
        if (ctx == null) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
        } catch (Throwable t) {
            // ignore
        }
    }

    static void createChannel(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "运动状态", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("跑步进行中的常驻控制条");
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        } catch (Throwable t) {
            // ignore
        }
    }

    static PendingIntent actionIntent(Context ctx, String action) {
        Intent i = new Intent(ctx, RunNotificationReceiver.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, action.hashCode(), i, flags);
    }

    static Notification build(Context ctx, Data d) {
        createChannel(ctx);
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) {
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        int pFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(ctx, 7, open, pFlags);

        // 自定义 RemoteViews：图标化按钮（对齐 Salt Player 的媒体样式），不引第三方依赖。
        // 系统默认的 addAction 在多数国产 ROM 上渲染成文字按钮，出不来图标。
        android.widget.RemoteViews rv = new android.widget.RemoteViews(ctx.getPackageName(), R.layout.notif_run);
        rv.setTextViewText(R.id.notif_title, d.title);
        rv.setTextViewText(R.id.notif_info, (d.workout == null || d.workout.isEmpty()) ? d.text : d.workout);
        rv.setTextViewText(R.id.notif_track, d.track);

        // 图标随状态动态切换：播放中显示暂停键，暂停中显示播放键；运动同理
        rv.setImageViewResource(R.id.notif_play, d.playing ? R.drawable.ic_n_pause : R.drawable.ic_n_play);
        rv.setImageViewResource(R.id.notif_run, d.paused ? R.drawable.ic_n_play : R.drawable.ic_n_pause);
        rv.setOnClickPendingIntent(R.id.notif_prev, actionIntent(ctx, RunNotificationPlugin.ACTION_PREV));
        rv.setOnClickPendingIntent(R.id.notif_play, actionIntent(ctx, RunNotificationPlugin.ACTION_TOGGLE_PLAY));
        rv.setOnClickPendingIntent(R.id.notif_next, actionIntent(ctx, RunNotificationPlugin.ACTION_NEXT));
        rv.setOnClickPendingIntent(R.id.notif_run, actionIntent(ctx, RunNotificationPlugin.ACTION_TOGGLE_RUN));
        rv.setOnClickPendingIntent(R.id.notif_stop, actionIntent(ctx, RunNotificationPlugin.ACTION_STOP_RUN));

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(d.title)
                .setContentText(d.text)
                .setContentIntent(content)
                .setCustomContentView(rv)
                .setCustomBigContentView(rv)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setShowWhen(false);

        // 仍带上 action（部分系统在折叠态只认 action 列表），标题用直观文字兜底
        b.addAction(android.R.drawable.ic_media_previous, "上一首",
                actionIntent(ctx, RunNotificationPlugin.ACTION_PREV));
        b.addAction(d.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                d.playing ? "暂停播放" : "开始播放",
                actionIntent(ctx, RunNotificationPlugin.ACTION_TOGGLE_PLAY));
        b.addAction(android.R.drawable.ic_media_next, "下一首",
                actionIntent(ctx, RunNotificationPlugin.ACTION_NEXT));
        if (d.running) {
            b.addAction(android.R.drawable.ic_media_pause, d.paused ? "开始运动" : "暂停运动",
                    actionIntent(ctx, RunNotificationPlugin.ACTION_TOGGLE_RUN));
            b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "结束运动",
                    actionIntent(ctx, RunNotificationPlugin.ACTION_STOP_RUN));
        }
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
