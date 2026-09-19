package com.luotianyi.run;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 通知条上按钮的点击入口：把动作回传给 JS。
 * 用显式广播（直接指定本类），避免 Android 8+ 对隐式广播的限制。
 */
public class RunNotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = (intent == null) ? null : intent.getAction();
        if (action == null) return;
        RunNotificationPlugin.dispatch(action);
    }
}
