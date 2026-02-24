import { ToastMood } from './types';

export const POLL_FAST_MS = 3000;
export const POLL_SLOW_MS = 10000;
export const SEARCH_RESULT_LIMIT = 6;
export const TOAST_MS = 4200;

export const TOAST_IMAGES: Record<ToastMood, readonly string[]> = Object.freeze({
  happy: ['/assets/syrja-happy.jpg', '/assets/syrja-sing.jpg'],
  stern: ['/assets/syrja-normal.jpg', '/assets/syrja-sad.jpg', '/assets/syrja-thinking.avif'],
  neutral: ['/assets/syrja-normal.jpg'],
});

export const TOAST_LINES = Object.freeze({
  searchError: [
    'Eppu sanoo: tästä hausta ei löytynyt mitään.',
    'Eppu ei vakuuttunut. Kokeile toista hakua.',
    'Eppu tuijotti YouTubea, mutta ei saanut mitään.',
  ],
  searchSuccess: [
    'Eppu hyväksyy: haku näyttää lupaavalta.',
    'Eppu sanoo, että makusi toimii tänään.',
    'Eppu nyökkää. Hyvä haku.',
  ],
  searchEmpty: [
    'Eppu ei löytänyt mitään lisättävää.',
    'Eppu sanoo, että jono kaipaa parempia hakusanoja.',
    'Eppu haluaa tarkemman haun.',
  ],
  addSearchError: [
    'Eppu sanoo, että jono hylkäsi kappaleen.',
    'Eppu ei pitänyt tästä lisäysyrityksestä.',
  ],
  addSearchOk: [
    'Eppu lisäsi kappaleen varman päälle.',
    'Eppu sanoo: puhdas lisäys, jatka samaan malliin.',
    'Eppu hyväksyy tämän jonopäätöksen.',
  ],
  addUrlError: [
    'Eppu sanoo, ettei tämä URL mennyt läpi.',
    'Eppu katsoi linkkiä ja kurtisti kulmiaan.',
  ],
  addUrlOk: [
    'Eppu sanoo, että suorat linkit toimivat nyt hyvin.',
    'Eppu tykkää tämän jonon energiasta.',
  ],
  pause: [
    'Eppu sanoo: rohkea tauko keskellä fiilistä.',
    'Eppu seuraa tätä dramaattista taukoa.',
  ],
  resume: [
    'Eppu sanoo: takaisin asiaan.',
    'Eppu hyväksyy jatkon.',
  ],
  skip: [
    'Eppu tiesi ohituksen jo ennen klikkausta.',
    'Eppu sanoo: seuraava biisi, ei armoa.',
  ],
  remove: [
    'Eppu sanoo, että yksi kappale poistettiin.',
    'Eppu hyväksyy tämän jonosiivouksen.',
  ],
  move: [
    'Eppu sanoo, että jonokoreografia on terävä.',
    'Eppu hyväksyy tämän taktisen siirron.',
  ],
} as const);
