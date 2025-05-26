const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LanguageSettingsSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  preferredLanguage: {
    type: String,
    enum: ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'zh-CN', 'ja-JP', 'ko-KR', 'ar-SA', 'hi-IN'],
    default: 'en-US'
  },
  interfaceLanguage: {
    type: String,
    enum: ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'zh-CN', 'ja-JP', 'ko-KR', 'ar-SA', 'hi-IN'],
    default: 'en-US'
  },
  voiceRecognitionLanguage: {
    type: String,
    enum: ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'zh-CN', 'ja-JP', 'ko-KR', 'ar-SA', 'hi-IN'],
    default: 'en-US'
  },
  autoTranslateEnabled: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = LanguageSettings = mongoose.model('languageSettings', LanguageSettingsSchema);