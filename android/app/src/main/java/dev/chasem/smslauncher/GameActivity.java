package dev.chasem.smslauncher;

import android.os.Bundle;
import android.os.Build;
import android.os.PowerManager;
import android.app.GameManager;
import android.app.GameState;
import android.content.Context;
import android.content.SharedPreferences;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.Display;
import java.io.File;
import java.util.ArrayList;
import org.libsdl.app.SDLActivity;
import org.libsdl.app.SDLSurface;

public class GameActivity extends SDLActivity {
    private final java.util.Set<Integer> assignedBackPresses = new java.util.HashSet<>();
    private volatile String displayRequest = "not requested";
    private volatile String gamePolicy = "not queried";
    private SharedPreferences settings() { return getSharedPreferences("settings", MODE_PRIVATE); }
    @Override protected SDLSurface createSDLSurface(Context context) {
        return new SDLSurface(context) {
            @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                // Set before SDL starts its native thread, and again when the
                // surface is recreated. This is a display hint, not a CPU lock.
                if (Build.VERSION.SDK_INT >= 30 && settings().getBoolean("match_display_rate", false)) {
                    float rate = "30".equals(settings().getString("frame_rate", "60")) ? 30f : 60f;
                    try {
                        holder.getSurface().setFrameRate(rate, Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE);
                        displayRequest = "requested " + rate + " FPS";
                    } catch (RuntimeException e) { displayRequest = "rejected: " + e.getClass().getSimpleName(); }
                } else displayRequest = Build.VERSION.SDK_INT < 30 ? "unavailable" : "disabled";
                super.surfaceChanged(holder, format, width, height);
            }
        };
    }
    private void reportGamePolicy(boolean playing) {
        if (Build.VERSION.SDK_INT < 31) { gamePolicy = "GameManager unavailable"; return; }
        try {
            GameManager manager = getSystemService(GameManager.class);
            if (manager == null) { gamePolicy = "GameManager unavailable"; return; }
            int mode = manager.getGameMode();
            String name = mode == GameManager.GAME_MODE_PERFORMANCE ? "performance"
                : mode == GameManager.GAME_MODE_BATTERY ? "battery"
                : mode == GameManager.GAME_MODE_STANDARD ? "standard" : "unsupported";
            String state = "unavailable";
            if (Build.VERSION.SDK_INT >= 33) {
                // Sunshine is pausable; do not claim uninterruptible network
                // play or permanent loading to obtain an inappropriate boost.
                manager.setGameState(new GameState(false,
                    playing ? GameState.MODE_GAMEPLAY_INTERRUPTIBLE : GameState.MODE_NONE));
                state = playing ? "gameplay interruptible" : "none";
            }
            gamePolicy = "game mode " + name + ", reported state " + state;
        } catch (RuntimeException e) { gamePolicy = "GameManager rejected: " + e.getClass().getSimpleName(); }
        android.util.Log.i("SMSLauncher", gamePolicy);
    }
    @Override protected void onResume() { reportGamePolicy(true); super.onResume(); }
    @Override protected void onPause() { super.onPause(); reportGamePolicy(false); }
    @Override protected String[] getLibraries() { return new String[]{"SDL2", "smsbootstrap"}; }
    @Override protected String[] getArguments() {
        File data = new File(getFilesDir(), "game");
        ArrayList<String> args = new ArrayList<>();
        args.add("--data"); args.add(data.getAbsolutePath());
        args.add("--libraries"); args.add(getApplicationInfo().nativeLibraryDir);
        args.add("--disc"); args.add(new File(getFilesDir(), "disc/game.iso").getAbsolutePath());
        args.add("--env"); args.add("SMS_SAVE_DIR=" + new File(getFilesDir(), "saves/card-a").getAbsolutePath());
        args.add("--env"); args.add("SMS_SETTINGS=" + new File(data, "settings.txt").getAbsolutePath());
        args.add("--env"); args.add("SMS_ANDROID_CONTROLLER_MAPPINGS=" + new File(getFilesDir(), "controller-mappings.txt").getAbsolutePath());
        PowerManager power = getSystemService(PowerManager.class);
        Display display = getWindow().getDecorView().getDisplay();
        args.add("--env"); args.add("SMS_ANDROID_STARTUP_POLICY=" + gamePolicy
            + "; " + BuildInfo.summary().replace('\n', ';')
            + ", battery saver " + (power != null && power.isPowerSaveMode())
            + ", display " + (display == null ? "unknown" : display.getRefreshRate() + " Hz")
            + ", " + displayRequest);
        if (BuildConfig.DEBUG) {
            if (getIntent().getBooleanExtra("gxSelftest", false)) { args.add("--gx-selftest"); args.add("1"); }
            String[] testEnvironment = getIntent().getStringArrayExtra("testEnvironment");
            if (testEnvironment != null) for (String value : testEnvironment) {
                if (value.startsWith("SMS_")) { args.add("--env"); args.add(value); }
            }
        }
        return args.toArray(new String[0]);
    }
    @Override protected void onCreate(Bundle state) {
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::finish);
    }
    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (event.getKeyCode() == android.view.KeyEvent.KEYCODE_BACK) {
            if(event.getAction()==android.view.KeyEvent.ACTION_DOWN&&ControllerProfiles.backAssigned(this,event.getDevice()))
                assignedBackPresses.add(event.getDeviceId());
            if(assignedBackPresses.contains(event.getDeviceId())) {
                if(event.getAction()==android.view.KeyEvent.ACTION_UP)assignedBackPresses.remove(event.getDeviceId());
                SDLActivity.handleKeyEvent(mSurface,event.getKeyCode(),event,null);
                return true;
            }
            if (event.getAction() == android.view.KeyEvent.ACTION_UP) finish();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
    @Override protected void onDestroy() {
        super.onDestroy();
        // The game owns global heaps, SDK threads, and caches. A fresh process
        // on each Play avoids carrying that state into the next session.
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
