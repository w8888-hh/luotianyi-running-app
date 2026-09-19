package com.luotianyi.run;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 运动常驻通知条：锁屏/通知栏可见，带切歌、播放暂停、运动暂停/开始/结束按钮。
 * JS 侧调用 show/update/hide，按钮点击通过 "action" 事件回传。
 */
@CapacitorPlugin(name = "RunNotification")
public class RunNotificationPlugin extends Plugin {

    public static final String ACTION_PREV = "prev";
    public static final String ACTION_NEXT = "next";
    public static final String ACTION_TOGGLE_PLAY = "togglePlay";
    public static final String ACTION_TOGGLE_RUN = "toggleRun";
    public static final String ACTION_STOP_RUN = "stopRun";

    static RunNotificationPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_POST_NOTIF) return;
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        onPermResult(granted);
        // 权限刚拿到就补一次显示，用户不用再点一次开始
        if (granted && lastShowData != null) {
            RunNotificationService.Data d = lastShowData;
            lastShowData = null;
            try {
                startOrUpdate(getContext(), d, true);
            } catch (Throwable t) {
                // ignore
            }
        }
    }

    static RunNotificationService.Data lastShowData;

    private RunNotificationService.Data dataFrom(PluginCall call) {
        RunNotificationService.Data d = new RunNotificationService.Data();
        d.title = call.getString("title", "洛天依陪跑");
        d.text = call.getString("text", "");
        d.bigText = call.getString("bigText", "");
        d.track = call.getString("track", "");
        d.workout = call.getString("workout", "");
        d.playing = call.getBoolean("playing", Boolean.FALSE);
        d.running = call.getBoolean("running", Boolean.FALSE);
        d.paused = call.getBoolean("paused", Boolean.FALSE);
        return d;
    }

    static final int REQ_POST_NOTIF = 2001;

    /** Android 13+ 的通知是运行时权限，不申请的话通知根本不会显示 */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        int st = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS);
        if (st == PackageManager.PERMISSION_GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        // 先存着 call，用户选择后再 resolve
        pendingPermCall = call;
        if (getActivity() == null) {
            onPermResult(false);
            return;
        }
        ActivityCompat.requestPermissions(getActivity(),
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIF);
    }

    private static PluginCall pendingPermCall;

    void onPermResult(boolean granted) {
        PluginCall c = pendingPermCall;
        pendingPermCall = null;
        if (c == null) return;
        JSObject r = new JSObject();
        r.put("granted", granted);
        c.resolve(r);
    }

    private void requestPostNotif() {
        try {
            if (Build.VERSION.SDK_INT < 33) return;
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) return;
            if (getActivity() == null) return;
            ActivityCompat.requestPermissions(getActivity(),
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIF);
        } catch (Throwable t) {
            // ignore
        }
    }

    /** show 走前台服务，update 走普通 startService（服务已在跑时不需要再申请前台资格） */
    private void startOrUpdate(Context ctx, RunNotificationService.Data d, boolean asForeground) {
        Intent i = new Intent(ctx, RunNotificationService.class);
        i.setAction(asForeground ? RunNotificationService.ACTION_START : RunNotificationService.ACTION_UPDATE);
        RunNotificationService.applyIntent(i, d);
        try {
            if (asForeground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable t) {
            // 前台服务起不来（后台启动限制 / 系统拦截）就退回普通常驻通知，功能不丢
            RunNotificationService.postOnly(ctx, d);
        }
    }

    @PluginMethod
    public void show(PluginCall call) {
        Context ctx = getContext();
        RunNotificationService.Data d = dataFrom(call);
        try {
            // 没权限就先申请，拿到后自动补显示（见 handleRequestPermissionsResult）。
            // 这里绝对不能启动服务：服务里 notify 会在 Android 13+ 直接抛 SecurityException 崩进程。
            if (!RunNotificationService.canPost(ctx)) {
                lastShowData = d;
                requestPostNotif();
                call.resolve();
                return;
            }
            lastShowData = null;
            startOrUpdate(ctx, d, true);
        } catch (Throwable t) {
            // ignore
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Context ctx = getContext();
        RunNotificationService.Data d = dataFrom(call);
        try {
            if (!RunNotificationService.canPost(ctx)) {
                lastShowData = d;
                call.resolve();
                return;
            }
            startOrUpdate(ctx, d, false);
        } catch (Throwable t) {
            // ignore
        }
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent i = new Intent(ctx, RunNotificationService.class);
            i.setAction(RunNotificationService.ACTION_HIDE);
            ctx.startService(i);
        } catch (Throwable t) {
            RunNotificationService.cancel(ctx);
        }
        lastShowData = null;
        call.resolve();
    }

    /** 由通知按钮的广播接收器回调 */
    static void dispatch(String action) {
        try {
            if (instance == null) return;
            final android.app.Activity act = instance.getActivity();
            if (act == null) return;
            final String a = action;
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        JSObject o = new JSObject();
                        o.put("action", a);
                        instance.notifyListeners("action", o);
                    } catch (Throwable t) {
                        // ignore
                    }
                }
            });
        } catch (Throwable t) {
            // ignore
        }
    }
}
