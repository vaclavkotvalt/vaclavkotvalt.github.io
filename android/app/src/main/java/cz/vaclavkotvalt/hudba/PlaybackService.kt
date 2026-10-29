package cz.vaclavkotvalt.hudba

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Přehrávání běží tady, mimo obrazovku aplikace: hraje na pozadí i se zhasnutou obrazovkou
 * a Android k němu sám ukazuje ovládání v notifikační liště a na zamčené obrazovce.
 */
class PlaybackService : MediaSessionService() {

    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true, // ztiší se při hovoru nebo když hraje jiná aplikace
            )
            .setHandleAudioBecomingNoisy(true) // pauza po odpojení sluchátek
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = savePosition()
            override fun onIsPlayingChanged(isPlaying: Boolean) = savePosition()
        })

        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelName(R.string.channel_name)
                .build()
                .apply { setSmallIcon(R.drawable.ic_stat_hudba) }
        )

        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(openApp)
            .setCallback(object : MediaSession.Callback {
                // Skladby z obrazovky aplikace přijdou jen s ID – adresu souboru doplníme tady.
                override fun onAddMediaItems(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: MutableList<MediaItem>,
                ): ListenableFuture<MutableList<MediaItem>> = Futures.immediateFuture(
                    mediaItems.map { item ->
                        item.buildUpon().setUri(Library.uri(item.mediaId.toLong())).build()
                    }.toMutableList()
                )
            })
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    // Po zavření aplikace ze seznamu spuštěných: když hraje, hraje dál; když ne, služba skončí.
    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player
        if (player == null || !player.playWhenReady || player.mediaItemCount == 0 ||
            player.playbackState == Player.STATE_ENDED
        ) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        savePosition()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    /** Kde se skončilo, aby příště aplikace pokračovala stejnou skladbou. */
    private fun savePosition() {
        val player = session?.player ?: return
        val item = player.currentMediaItem ?: return
        getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
            .putString("lastId", item.mediaId)
            .putLong("lastPos", player.currentPosition)
            .apply()
    }
}
