import { createHmac } from 'node:crypto'
import QRCode from 'qrcode'

/**
 * DEN ANIMERADE QR-KODEN
 *
 * BankID v6 kräver att QR-koden byts varje sekund. Koden är kryptografiskt
 * bunden till ordern och till tiden:
 *
 *   qrAuthCode = HMAC-SHA256(qrStartSecret, sekunder sedan auth-svaret)
 *   qrData     = "bankid." + qrStartToken + "." + sekunder + "." + qrAuthCode
 *
 * VARFÖR DEN ÄR ANIMERAD
 *
 * En statisk QR-kod går att fotografera och skicka vidare. En angripare kan
 * ringa upp någon, visa en QR-kod på sin egen skärm och förmå offret att
 * skanna den — och då har angriparen legitimerat sig som offret. Att koden
 * bara gäller i någon sekund gör det angreppet opraktiskt: bilden är död innan
 * den hunnit vidarebefordras.
 *
 * VARFÖR HEMLIGHETEN MÅSTE STANNA PÅ SERVERN
 *
 * `qrStartSecret` delas bara mellan BankID och den anropande tjänsten. Nådde
 * den klienten kunde vem som helst räkna fram giltiga koder för ordern i all
 * framtid, och animeringen vore verkningslös. Beräkningen sker därför här, på
 * servern, och klienten får bara den färdiga strängen — som är värdelös en
 * sekund senare.
 */

/**
 * Räknar fram QR-kodens data för en given tidpunkt.
 *
 * Sekunderna räknas från när auth-svaret kom, inte från när begäran gjordes.
 * Skillnaden spelar roll: BankID validerar koden mot sin egen uppfattning om
 * orderns ålder, och en klocka som börjar räkna för tidigt ger koder som
 * avvisas.
 */
export function computeQrData(
  qrStartToken: string,
  qrStartSecret: string,
  elapsedSeconds: number,
): string {
  const seconds = Math.max(0, Math.floor(elapsedSeconds))

  const qrAuthCode = createHmac('sha256', qrStartSecret)
    .update(String(seconds), 'utf8')
    .digest('hex')

  return `bankid.${qrStartToken}.${seconds}.${qrAuthCode}`
}

/**
 * Renderar QR-strängen till en PNG som data-URI.
 *
 * VARFÖR BILDEN GÖRS PÅ SERVERN
 *
 * Alternativet vore att skicka strängen till klienten och rendera den där med
 * ett QR-bibliotek. Det fungerar, men innehållssäkerhetspolicyn tillåter bara
 * skript från egen origin och inga inline-skript — och en data-URI-bild ryms
 * redan i `img-src 'self' data:`. Serverrendering ger alltså samma resultat
 * utan att policyn behöver luckras upp och utan ett extra klientberoende.
 *
 * Felkorrigeringsnivå M är BankID:s rekommendation: tillräckligt robust för en
 * skärm som fotograferas i vinkel, utan att koden blir så tät att en telefon
 * får svårt att läsa den.
 */
export async function renderQrPng(qrData: string): Promise<string> {
  return QRCode.toDataURL(qrData, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#000000ff', light: '#ffffffff' },
  })
}

/**
 * Hur länge en order får leva innan QR-koden slutar genereras.
 *
 * BankID låter en order gå ut av sig själv, men att sluta producera koder
 * lokalt sparar onödiga anrop och gör att gränssnittet kan visa något
 * begripligt i stället för att fortsätta animera en död kod.
 */
export const QR_ORDER_LIFETIME_SECONDS = 30

/**
 * URL som öppnar BankID-appen på samma enhet.
 *
 * iOS kräver universal link-varianten; övriga plattformar använder
 * app-schemat. Skillnaden ligger i att Safari inte följer ett okänt schema
 * från en länk användaren klickat i vissa sammanhang.
 *
 * `redirect=null` avslutar appen utan att öppna någon URL, så att sidan som
 * startade legitimeringen hamnar i fokus igen. Att inte låta värdet styras
 * utifrån är medvetet: en påverkbar redirect i ett flöde som just legitimerat
 * någon är en omdirigeringssårbarhet med särskilt dålig tajming.
 */
export function launchUrl(autoStartToken: string, platform: 'ios' | 'other'): string {
  const token = encodeURIComponent(autoStartToken)

  return platform === 'ios'
    ? `https://app.bankid.com/?autostarttoken=${token}&redirect=null`
    : `bankid:///?autostarttoken=${token}&redirect=null`
}
