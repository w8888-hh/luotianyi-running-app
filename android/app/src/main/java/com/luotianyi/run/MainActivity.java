package com.luotianyi.run;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件显式注册（自动扫描在部分版本上不可靠）
        registerPlugin(RunNotificationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
