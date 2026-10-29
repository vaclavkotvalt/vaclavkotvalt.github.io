package cz.vaclavkotvalt.hudba

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import java.text.Collator
import java.util.Locale

data class Track(val id: Long, val title: String, val artist: String, val albumId: Long)

/** Hudba v telefonu, jak ji zná Android (MediaStore) – včetně složky Stažené. */
object Library {

    val permission: String
        get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO
        else Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun load(context: Context): List<Track> {
        val media = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM_ID,
        )
        // jen hudba; bez hlasových zpráv a nahrávek, které si aplikace (WhatsApp apod.) ukládají do Android/
        var selection = "${MediaStore.Audio.Media.IS_MUSIC} != 0"
        if (Build.VERSION.SDK_INT >= 29) {
            selection += " AND ${MediaStore.Audio.Media.RELATIVE_PATH} NOT LIKE 'Android/%'"
        }

        val tracks = mutableListOf<Track>()
        context.contentResolver.query(media, projection, selection, null, null)?.use { c ->
            val id = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val title = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
            val artist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
            val album = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID)
            while (c.moveToNext()) {
                val a = c.getString(artist).orEmpty()
                tracks += Track(
                    id = c.getLong(id),
                    title = c.getString(title).orEmpty().ifBlank { "?" },
                    artist = if (a == MediaStore.UNKNOWN_STRING) "" else a,
                    albumId = c.getLong(album),
                )
            }
        }
        val collator = Collator.getInstance(Locale("cs"))
        return tracks.sortedWith { a, b -> collator.compare(a.title, b.title) }
    }

    fun uri(id: Long): Uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)

    fun albumArtUri(albumId: Long): Uri =
        ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), albumId)

    fun toMediaItem(t: Track): MediaItem =
        MediaItem.Builder()
            .setMediaId(t.id.toString())
            .setUri(uri(t.id))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title)
                    .setArtist(t.artist.ifEmpty { null })
                    .setArtworkUri(albumArtUri(t.albumId))
                    .build()
            )
            .build()
}
