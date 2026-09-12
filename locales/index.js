// GhostTrace - Dil Paketleri Yöneticisi (Language Registry)

import tr from './tr.js';
import en from './en.js';

export const dictionaries = {
  tr,
  en
};

export const AVAILABLE_LANGUAGES = [
  { code: 'auto', labelKey: 'options.langAuto' },
  { code: 'tr', labelKey: 'options.langTr' },
  { code: 'en', labelKey: 'options.langEn' }
];

export default dictionaries;
