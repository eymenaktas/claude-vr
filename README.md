# Claude Ses

Meta Quest için sesli Claude Code. Gözlükteyken, hatta oyun oynarken, Mac'inde çalışan Claude Code oturumlarıyla (Remote Control dahil) konuşursun. Claude cevabını kendi sesiyle okur, altyazı alt kısımda akar.

> Resmî bir Anthropic ürünü değildir, Anthropic ile bağlantısı yoktur. claude.ai'nin web arayüzünü kendi hesabınla kullanır.

## Ne yapar

- **Tıklamasız sesli döngü.** Konuşursun, sustuğunda mesaj gider. Claude bitirince cevabı okur, sonra yine dinler.
- **"Hey Claude" modu.** Arkada sürekli dinler, yalnızca "Hey Claude" ile başlayan sözleri gönderir. İstersen "her şeyi" moduna geçip doğrudan konuşabilirsin. Claude çalışırken de duyar, mesaj sıraya girer.
- **Ara mesajları da okur.** Claude çalışırken yazdığı her ara notu, claude.ai'nin "Read aloud" sesiyle (44,1 kHz) okur. Bitince yalnızca okunmamış kısmı okur.
- **Araya girme.** Claude konuşurken konuşmaya başlarsan susar ve seni dinler.
- **Claude'un kendi diktesi.** Remote Control oturumlarında Dictate düğmesi olmadığından dikte, arkada açık duran görünmez bir claude.ai sayfasında yapılır ve metin oturuma aktarılır.
- **İzin istekleri ekranda.** Claude bir işlem için izin isterse kart çıkar, onaylayabilirsin.
- **Ekranı görme (isteğe bağlı).** "Ekranı göster" açıkken mesajlara gözlükteki görüntünün son 5 saniyesinden kareler eklenir.
- **Görsel / video gösterme.** Mac'teki ajan `tools/goster.sh <dosya|url> [başlık]` ile gözlükteki pencerede resim, video, YouTube ya da HTML sayfası açar (`--kapat` ile kapatır). Yerel dosyalar adb ile gözlüğe kopyalanır.
- **Bildirim.** Uygulama öndeyken değilse, Claude bitirince ya da izin isteyince bildirim gelir.
- **Son oturum.** Uygulama en son kullandığın oturumla açılır. Pencere boyutlandırılabilir, oyunun üstünde durabilir.
- **Claude'a VR'dan konuştuğunu söyler.** Dikteyle giden mesajların sonuna "— Quest'ten sesli" eklenir. Ajan kurallarında buna göre kısa, sesli okunmaya uygun cevap istenebilir.

## Yapı

```
android/   Quest uygulaması (WebView + enjekte edilen sesli mod)
  assets/overlay.js         sesli mod: arayüz, durum makinesi, TTS oynatıcı
  assets/dictate-helper.js  görünmez dikte sayfası (claude.ai/new)
  src/…/MainActivity.java   WebView, köprü, izinler
  src/…/MicService.java     oyun öndeyken mikrofonu koruyan ön plan servisi
  src/…/ScreenCaptureService.java  ekran kareleri (MediaProjection)
  src/…/WhisperClient.java  isteğe bağlı: kendi mikrofonu + Mac'teki whisper-server, araya girme algılama
mac/       İsteğe bağlı menü çubuğu uygulaması: Quest isteyince whisper-server'ı başlatır
mock/      Yerel test için sahte claude.ai sayfası
```

## Derleme

Gradle gerekmez. Android SDK (platform 36, build-tools) ve JDK 17+ yeter.

```bash
cd android && ./build.sh
adb install -r build/claude-ses.apk
```

İlk derlemede `~/.android/claude-ses.keystore` ve yanında şifre dosyası oluşturulur. Quest'te geliştirici modu açık olmalı. Uygulama "Bilinmeyen kaynaklar" altında görünür.

İsteğe bağlı Mac sunucusu (whisper.cpp ve `ggml-large-v3-turbo-q5_0.bin` modeli gerekir):

```bash
cd mac && ./build.sh
```

## Notlar

- claude.ai'nin arayüzü değiştikçe seçiciler (`data-testid`, `aria-label`) güncellenmeli.
- Quest'in yerleşik konuşma tanıma ve seslendirme servisleri yalnızca İngilizce. Bu yüzden Türkçe için claude.ai'nin kendi diktesi ve sesi kullanılıyor.

## Lisans

MIT
