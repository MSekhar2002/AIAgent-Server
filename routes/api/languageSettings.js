const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const LanguageSettings = require('../../models/LanguageSettings');
const User = require('../../models/User');

// @route   GET api/language-settings
// @desc    Get current user's language settings
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    // Find user and populate language settings
    const user = await User.findById(req.user.id).populate('languageSettings');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // If user doesn't have language settings yet, create default settings
    if (!user.languageSettings) {
      const newLanguageSettings = new LanguageSettings({
        preferredLanguage: 'en-US',
        interfaceLanguage: 'en-US',
        voiceRecognitionLanguage: 'en-US',
        autoTranslateEnabled: false
      });
      
      const languageSettings = await newLanguageSettings.save();
      
      // Update user with reference to new language settings
      user.languageSettings = languageSettings._id;
      await user.save();
      
      return res.json(languageSettings);
    }
    
    res.json(user.languageSettings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT api/language-settings
// @desc    Update user's language settings
// @access  Private
router.put('/', auth, async (req, res) => {
  const {
    preferredLanguage,
    interfaceLanguage,
    voiceRecognitionLanguage,
    autoTranslateEnabled
  } = req.body;
  
  try {
    // Find user and populate language settings
    const user = await User.findById(req.user.id).populate('languageSettings');
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }
    
    // If user doesn't have language settings yet, create new settings
    if (!user.languageSettings) {
      const newLanguageSettings = new LanguageSettings({
        preferredLanguage: preferredLanguage || 'en-US',
        interfaceLanguage: interfaceLanguage || 'en-US',
        voiceRecognitionLanguage: voiceRecognitionLanguage || 'en-US',
        autoTranslateEnabled: autoTranslateEnabled !== undefined ? autoTranslateEnabled : false
      });
      
      const languageSettings = await newLanguageSettings.save();
      
      // Update user with reference to new language settings
      user.languageSettings = languageSettings._id;
      await user.save();
      
      return res.json(languageSettings);
    }
    
    // Update existing language settings
    const languageSettingsFields = {};
    if (preferredLanguage) languageSettingsFields.preferredLanguage = preferredLanguage;
    if (interfaceLanguage) languageSettingsFields.interfaceLanguage = interfaceLanguage;
    if (voiceRecognitionLanguage) languageSettingsFields.voiceRecognitionLanguage = voiceRecognitionLanguage;
    if (autoTranslateEnabled !== undefined) languageSettingsFields.autoTranslateEnabled = autoTranslateEnabled;
    
    const updatedLanguageSettings = await LanguageSettings.findByIdAndUpdate(
      user.languageSettings._id,
      { $set: languageSettingsFields },
      { new: true }
    );
    
    res.json(updatedLanguageSettings);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/language-settings/supported-languages
// @desc    Get list of supported languages
// @access  Public
router.get('/supported-languages', async (req, res) => {
  try {
    // Return list of supported languages
    const supportedLanguages = [
      { code: 'en-US', name: 'English (US)', region: 'United States' },
      { code: 'en-GB', name: 'English (UK)', region: 'United Kingdom' },
      { code: 'es-ES', name: 'Spanish', region: 'Spain' },
      { code: 'fr-FR', name: 'French', region: 'France' },
      { code: 'de-DE', name: 'German', region: 'Germany' },
      { code: 'it-IT', name: 'Italian', region: 'Italy' },
      { code: 'pt-BR', name: 'Portuguese', region: 'Brazil' },
      { code: 'zh-CN', name: 'Chinese (Simplified)', region: 'China' },
      { code: 'ja-JP', name: 'Japanese', region: 'Japan' },
      { code: 'ko-KR', name: 'Korean', region: 'South Korea' },
      { code: 'ar-SA', name: 'Arabic', region: 'Saudi Arabia' },
      { code: 'ru-RU', name: 'Russian', region: 'Russia' },
      { code: 'hi-IN', name: 'Hindi', region: 'India' },
      { code: 'nl-NL', name: 'Dutch', region: 'Netherlands' },
      { code: 'sv-SE', name: 'Swedish', region: 'Sweden' }
    ];
    
    res.json(supportedLanguages);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET api/language-settings/voice-recognition-languages
// @desc    Get list of supported voice recognition languages
// @access  Public
router.get('/voice-recognition-languages', async (req, res) => {
  try {
    // Return list of supported voice recognition languages
    // This might be a subset of all supported languages depending on Azure Speech Services capabilities
    const voiceRecognitionLanguages = [
      { code: 'en-US', name: 'English (US)', region: 'United States' },
      { code: 'en-GB', name: 'English (UK)', region: 'United Kingdom' },
      { code: 'es-ES', name: 'Spanish', region: 'Spain' },
      { code: 'fr-FR', name: 'French', region: 'France' },
      { code: 'de-DE', name: 'German', region: 'Germany' },
      { code: 'it-IT', name: 'Italian', region: 'Italy' },
      { code: 'pt-BR', name: 'Portuguese', region: 'Brazil' },
      { code: 'zh-CN', name: 'Chinese (Simplified)', region: 'China' },
      { code: 'ja-JP', name: 'Japanese', region: 'Japan' },
      { code: 'ar-SA', name: 'Arabic', region: 'Saudi Arabia' },
      { code: 'ru-RU', name: 'Russian', region: 'Russia' },
      { code: 'hi-IN', name: 'Hindi', region: 'India' }
    ];
    
    res.json(voiceRecognitionLanguages);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;