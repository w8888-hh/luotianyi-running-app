package com.luotianyi.run;

import android.content.Intent;
import android.os.Bundle;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/** Native audio-only playback service for short-lived Bilibili DASH audio URLs. */
public class BiliMediaService extends MediaSessionService {
    static final String ACTION_PLAY = "com.luotianyi.run.bili.PLAY";
    static final String ACTION_PAUSE = "com.luotianyi.run.bili.PAUSE";
    static final String ACTION_RESUME = "com.luotianyi.run.bili.RESUME";
    static final String ACTION_SEEK = "com.luotianyi.run.bili.SEEK";
    static final String ACTION_STOP = "com.luotianyi.run.bili.STOP";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ARTIST = "artist";
    static final String EXTRA_POSITION = "position";

    private ExoPlayer player;
    private MediaSession mediaSession;

    @Override public void onCreate() {
        super.onCreate();
        // Bilibili's CDN rejects requests without a browser Referer/UA.
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .setDefaultRequestProperties(java.util.Collections.singletonMap("Referer", "https://www.bilibili.com/"));
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)))
                .build();
        player.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean isPlaying) { emitState("playing"); }
            @Override public void onPlaybackStateChanged(int state) { emitState("state"); }
            @Override public void onPlayerError(PlaybackException error) { emitError(error.getErrorCodeName()); }
            @Override public void onMediaItemTransition(@Nullable MediaItem item, int reason) { emitState("track"); }
        });
        mediaSession = new MediaSession.Builder(this, player).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_PLAY.equals(action)) play(intent);
            else if (ACTION_PAUSE.equals(action)) player.pause();
            else if (ACTION_RESUME.equals(action)) player.play();
            else if (ACTION_SEEK.equals(action)) player.seekTo(Math.max(0L, intent.getLongExtra(EXTRA_POSITION, 0L)));
            else if (ACTION_STOP.equals(action)) { player.stop(); stopSelf(); }
        }
        return START_STICKY;
    }

    private void play(Intent intent) {
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) { emitError("AUDIO_URL_EMPTY"); return; }
        String title = intent.getStringExtra(EXTRA_TITLE);
        String artist = intent.getStringExtra(EXTRA_ARTIST);
        MediaMetadata metadata = new MediaMetadata.Builder().setTitle(title == null ? "哔哩哔哩音频" : title)
                .setArtist(artist == null ? "哔哩哔哩" : artist).build();
        MediaItem item = new MediaItem.Builder().setUri(url).setMediaMetadata(metadata).build();
        player.setMediaItem(item);
        player.prepare();
        player.play();
        emitState("prepared");
    }

    private void emitState(String reason) {
        if (player == null) return;
        BiliSourcePlugin.dispatchMediaState(player.isPlaying(), player.getPlaybackState(), player.getCurrentPosition(), player.getDuration(), reason);
    }
    private void emitError(String error) { BiliSourcePlugin.dispatchMediaError(error); }

    @Nullable @Override public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) { return mediaSession; }

    @Override public void onDestroy() {
        if (mediaSession != null) { mediaSession.release(); mediaSession = null; }
        if (player != null) { player.release(); player = null; }
        super.onDestroy();
    }
}
