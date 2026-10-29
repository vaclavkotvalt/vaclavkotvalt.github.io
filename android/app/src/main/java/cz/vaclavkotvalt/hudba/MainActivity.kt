package cz.vaclavkotvalt.hudba

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Size
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Obrazovka aplikace. Vzhled je stejná webová stránka jako na vaclavkotvalt.cz/hudba
 * (soubory v assets/web), přehrávání ale obstarává [PlaybackService].
 * Stránka posílá příkazy přes objekt HudbaNative a stav dostává voláním hudbaState()/hudbaLibrary().
 */
class MainActivity : ComponentActivity() {

    companion object {
        const val PREFS = "hudba"
        private const val PAGE = "https://appassets.androidplatform.net/assets/web/index.html"
    }

    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }

    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var tracksById: Map<String, Track> = emptyMap()
    private var pageReady = false
    private var libraryLoaded = false
    private var pushedLibrary: String? = null

    private val askPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            // „Nepovolit“ dvakrát → Android už se nezeptá; pak pomůže jen nastavení aplikace
            if (!granted && !shouldShowRequestPermissionRationale(Library.permission)) {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                )
            }
            loadLibrary()
        }

    // pozice ve skladbě pro posuvník, dvakrát za vteřinu
    private val ticker = object : Runnable {
        override fun run() {
            pushState()
            main.postDelayed(this, 500)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) pushLibrary()
            pushState()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // obsah až k okrajům, ale stránka odsazená od stavového řádku a navigační lišty
        WindowCompat.setDecorFitsSystemWindows(window, false)
        web = WebView(this)
        val root = FrameLayout(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.bg))
            addView(web)
        }
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/art/", WebViewAssetLoader.PathHandler { path -> coverFor(path) })
            .build()
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.bg))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // jazyk CZ/EN se pamatuje v localStorage
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
        }
        web.addJavascriptInterface(Bridge(), "HudbaNative")
        web.loadUrl(PAGE)

        // tlačítko Zpět jen schová aplikaci, hudba hraje dál a po návratu je vše, jak bylo
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
    }

    override fun onStart() {
        super.onStart()
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            if (controllerFuture !== future) return@addListener
            controller = future.get().also { it.addListener(playerListener) }
            loadLibrary()
        }, ContextCompat.getMainExecutor(this))
        main.post(ticker)
    }

    override fun onStop() {
        main.removeCallbacks(ticker)
        controller?.removeListener(playerListener)
        controller = null
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        super.onStop()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Načte hudbu z telefonu (při každém otevření, aby se objevily nově stažené písničky). */
    private fun loadLibrary() {
        if (!Library.hasPermission(this)) {
            libraryLoaded = true
            pushLibrary()
            return
        }
        Thread {
            val tracks = Library.load(applicationContext)
            main.post {
                tracksById = tracks.associateBy { it.id.toString() }
                libraryLoaded = true
                controller?.let { syncPlaylist(it, tracks) }
                pushLibrary()
                pushState()
            }
        }.start()
    }

    private fun syncPlaylist(c: MediaController, tracks: List<Track>) {
        val currentIds = (0 until c.mediaItemCount).map { c.getMediaItemAt(it).mediaId }
        val newIds = tracks.map { it.id.toString() }
        if (currentIds == newIds) return

        if (c.mediaItemCount == 0 || !c.isPlaying) {
            // pokračovat tam, kde se naposledy skončilo
            val lastId = c.currentMediaItem?.mediaId ?: prefs.getString("lastId", null)
            val lastPos = if (c.currentMediaItem != null) c.currentPosition else prefs.getLong("lastPos", 0)
            val index = newIds.indexOf(lastId)
            if (c.mediaItemCount == 0) {
                c.shuffleModeEnabled = prefs.getBoolean("shuffle", false)
                c.repeatMode = prefs.getInt("repeat", Player.REPEAT_MODE_ALL)
            }
            if (tracks.isEmpty()) {
                c.clearMediaItems()
                return
            }
            c.setMediaItems(
                tracks.map(Library::toMediaItem),
                if (index >= 0) index else 0,
                if (index >= 0) lastPos else 0,
            )
            c.prepare()
        } else {
            // právě hraje – nepřerušovat: smazané skladby odebrat, nové přidat na konec
            val keep = newIds.toSet()
            for (i in currentIds.indices.reversed()) {
                if (currentIds[i] !in keep) c.removeMediaItem(i)
            }
            val have = currentIds.toSet()
            val added = tracks.filter { it.id.toString() !in have }
            if (added.isNotEmpty()) c.addMediaItems(added.map(Library::toMediaItem))
        }
    }

    private fun js(code: String) {
        if (pageReady) web.evaluateJavascript(code, null)
    }

    /** Seznam skladeb ve stejném pořadí jako v přehrávači (index ve stránce = index v přehrávači). */
    private fun pushLibrary() {
        if (!pageReady || !libraryLoaded) return
        val list = JSONArray()
        controller?.let { c ->
            for (i in 0 until c.mediaItemCount) {
                val id = c.getMediaItemAt(i).mediaId
                val t = tracksById[id]
                val meta = c.getMediaItemAt(i).mediaMetadata
                list.put(JSONObject().apply {
                    put("id", id)
                    put("title", t?.title ?: meta.title?.toString() ?: "?")
                    put("artist", t?.artist ?: meta.artist?.toString() ?: "")
                })
            }
        }
        val lib = JSONObject().apply {
            put("permission", Library.hasPermission(this@MainActivity))
            put("tracks", list)
        }.toString()
        if (lib == pushedLibrary) return
        pushedLibrary = lib
        js("window.hudbaLibrary && hudbaLibrary($lib)")
    }

    private fun pushState() {
        val c = controller ?: return
        val state = JSONObject().apply {
            put("index", if (c.mediaItemCount > 0) c.currentMediaItemIndex else -1)
            put("id", c.currentMediaItem?.mediaId ?: "")
            put("playing", c.isPlaying || (c.playWhenReady && c.playbackState == Player.STATE_BUFFERING))
            put("position", c.currentPosition)
            put("duration", c.duration.coerceAtLeast(0))
            put("shuffle", c.shuffleModeEnabled)
            put("repeat", when (c.repeatMode) {
                Player.REPEAT_MODE_ONE -> "one"
                Player.REPEAT_MODE_ALL -> "all"
                else -> "off"
            })
        }
        js("window.hudbaState && hudbaState($state)")
    }

    /** Obal alba skladby pro stránku: /art/<id skladby>. */
    private fun coverFor(path: String): WebResourceResponse {
        try {
            val id = path.substringBefore('?').toLong()
            val bytes = if (Build.VERSION.SDK_INT >= 29) {
                val bmp = contentResolver.loadThumbnail(Library.uri(id), Size(512, 512), null)
                ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
            } else {
                val album = tracksById[id.toString()]?.albumId ?: throw IllegalStateException()
                contentResolver.openInputStream(Library.albumArtUri(album))!!.use { it.readBytes() }
            }
            return WebResourceResponse("image/jpeg", null, ByteArrayInputStream(bytes))
        } catch (e: Exception) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    /** Příkazy ze stránky. Volají se z vlákna WebView, přehrávač chce hlavní vlákno. */
    private inner class Bridge {
        private fun onMain(block: (MediaController) -> Unit) = main.post { controller?.let(block) }

        @JavascriptInterface
        fun ready() = main.post {
            pageReady = true
            pushedLibrary = null
            pushLibrary()
            pushState()
        }

        @JavascriptInterface
        fun requestPermission() = main.post { askPermission.launch(Library.permission) }

        @JavascriptInterface
        fun rescan() = main.post { loadLibrary() }

        @JavascriptInterface
        fun playIndex(index: Int) = onMain {
            if (index in 0 until it.mediaItemCount) {
                it.seekToDefaultPosition(index)
                it.play()
            }
        }

        @JavascriptInterface
        fun toggle() = onMain {
            if (it.isPlaying) {
                it.pause()
            } else {
                if (it.playbackState == Player.STATE_IDLE) it.prepare()
                if (it.playbackState == Player.STATE_ENDED) it.seekToDefaultPosition()
                it.play()
            }
        }

        @JavascriptInterface
        fun next() = onMain { it.seekToNext() }

        // jako na webu: po 3 vteřinách skladby skočí na její začátek, jinak na předchozí
        @JavascriptInterface
        fun prev() = onMain { it.seekToPrevious() }

        @JavascriptInterface
        fun seek(ms: Long) = onMain { it.seekTo(ms) }

        @JavascriptInterface
        fun setShuffle(on: Boolean) = onMain {
            it.shuffleModeEnabled = on
            prefs.edit().putBoolean("shuffle", on).apply()
        }

        @JavascriptInterface
        fun setRepeat(mode: String) = onMain {
            val m = when (mode) {
                "one" -> Player.REPEAT_MODE_ONE
                "off" -> Player.REPEAT_MODE_OFF
                else -> Player.REPEAT_MODE_ALL
            }
            it.repeatMode = m
            prefs.edit().putInt("repeat", m).apply()
        }
    }
}
