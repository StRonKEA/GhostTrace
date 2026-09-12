#!/usr/bin/env bash
# GhostTrace - TAM TUR: butun takimlar, sirayla, GERCEK sitelerde.
#
# Sirali kosar (paralel DEGIL): zamanlama olcumleri islemci yukune duyarli ve
# paralel kosum sapmayi buyutur. Her takim kendi gunlugune yazar, aralarda
# yalnizca TEST tarayicisi kapatilir (kullanicinin tarayicisina dokunulmaz).
cd "d:/Programlar/Portable/Helium/Eklentiler/GhostTrace" || exit 1
export GT_PROFILE="d:/Programlar/Portable/Helium/Eklentiler/GhostTrace/.cache/gt-manual-profile"

kosu() {
  echo "########## $1 ##########"
  npm run "$2" > "/tmp/tt-$1.log" 2>&1
  local kod=$?
  local ozet; ozet=$(grep -E "gecti$" "/tmp/tt-$1.log" | tail -1)
  local hata; hata=$(grep -cE "^  FAIL" "/tmp/tt-$1.log")
  echo "[$(date +%H:%M)] $1 -> ${ozet:-(ozet yok)} | FAIL=$hata | exit=$kod"
  npm run e2e:kill >/dev/null 2>&1
  # 3 -> 12 saniye. OLCULDU (2026-09-02): takimlar arka arkaya kosunca
  # `test:e2e` 0/9, `test:e2e:hatalar` 0/10 verdi ve ikisi de AYNI yerde
  # dustu - son "Gunlukte ERROR yok" iddiasinda, ayni hatayla:
  # "CDP zaman asimi (30000ms): Runtime.evaluate".
  # Ikisi de TEK BASINA kosunca tam gecti (9/9 ve 10/10) ve hatalar takimi
  # 5.2 dakika yerine 2.2 dakikada bitti - yani sebep kod degil, onceki
  # tarayicinin surecleri tam kapanmadan yenisinin acilmasi.
  # e2e:kill ana sureci indirir ama renderer/gpu surecleri bir an yasiyor.
  sleep 12
}

echo "[$(date +%H:%M)] TAM TUR BASLADI"
echo "########## BIRIM + LINT ##########"
npm test 2>&1 | grep -E "tests |pass |fail "
npx eslint . && echo "lint: temiz"
npm run e2e:kill >/dev/null 2>&1

# --- HIZLI TAKIMLAR ---
kosu scope           test:e2e
kosu matris          test:e2e:matris
kosu layout          test:e2e:layout
kosu features        test:e2e:features
kosu real            test:e2e:real
kosu gecmis          test:e2e:gecmis
kosu hatalar         test:e2e:hatalar
kosu restart         test:e2e:restart
# Surum oncesi kontrol listesinin 3. ve 5. maddesi (v2.8.0'da otomatiklesti).
kosu alarm           test:e2e:alarm
kosu gozlemci        test:e2e:gozlemci
echo "ASAMA_A_BITTI"

# --- IZIN GEREKTIRENLER (GT_PROFILE ile) ---
kosu incognito       test:e2e:incognito
kosu hardening       test:e2e:hardening
kosu contextmenu     test:e2e:contextmenu
kosu gizli           test:e2e:gizli
# ON KOSUL ELLE: arac cubugu menusunden site erisimi "tikladiginizda" olmali.
# Saglanmazsa OLCMEDEN cikar (exit=2) - ozette exit koduyla gorunur.
kosu erisim          test:e2e:erisim
echo "ASAMA_B_BITTI"

# --- GERCEK SITE AGIRLIKLI ---
kosu yetim           test:e2e:yetim
kosu gunluk          test:e2e:gunluk
kosu canli           test:e2e:canli
kosu live            test:e2e:live
kosu frames          test:e2e:frames
echo "ASAMA_C_BITTI"

# --- UZUN OLANLAR ---
kosu muhasebe        test:e2e:muhasebe
echo "ASAMA_D_BITTI"
# DAYANIKLILIK AYRI KOSAR. Sure 3 saat: 42 dakikalik denemede egriler zaten
# net cikti (oturum 2.7KB->133KB dogrusal, gunluk 500'de sabit, kuyruk sifira
# iniyor) ve 3'ten 6 saate cikmanin kazandirdigi tek sey birkac ek olcum
# noktasi. 3 saatte 4 muhasebe noktasi ve 90 dakikalik izin penceresi var.
#   GT_SAAT=3 npm run test:e2e:dayaniklilik
echo "[$(date +%H:%M)] TAM_TUR_BITTI"

echo ""
echo "=============== OZET ==============="
for f in /tmp/tt-*.log; do
  ad=$(basename "$f" .log); ad=${ad#tt-}
  ozet=$(grep -E "gecti$" "$f" | tail -1)
  hata=$(grep -cE "^  FAIL" "$f")
  printf "%-16s %-14s FAIL=%s\n" "$ad" "${ozet:-(yok)}" "$hata"
done
