const axios = require('axios');
const { SpeechConfig, AudioConfig, SpeechRecognizer, ResultReason } = require('microsoft-cognitiveservices-speech-sdk');

/**
 * Convert speech to text using Azure Speech Services
 * @param {string} audioUrl - URL to the audio file
 * @returns {Promise<string>} - Transcribed text
 */
const convertSpeechToText = async (audioUrl) => {
  try {
    // Get audio file from URL
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'arraybuffer'
    });
    
    const audioData = response.data;
    
    // Configure speech service
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    
    if (!speechKey || !speechRegion) {
      throw new Error('Azure Speech Services credentials not configured');
    }
    
    // Create speech configuration
    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = 'en-US';
    
    // Create audio configuration from the audio data
    const pushStream = AudioConfig.createPushStream();
    pushStream.write(audioData);
    pushStream.close();
    
    const audioConfig = AudioConfig.fromStreamInput(pushStream);
    
    // Create speech recognizer
    const recognizer = new SpeechRecognizer(speechConfig, audioConfig);
    
    // Start recognition
    return new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        result => {
          recognizer.close();
          if (result.reason === ResultReason.RecognizedSpeech) {
            resolve(result.text);
          } else {
            reject(new Error(`Speech recognition failed: ${result.reason}`));
          }
        },
        err => {
          recognizer.close();
          reject(err);
        }
      );
    });
  } catch (error) {
    console.error('Speech-to-text conversion error:', error.message);
    
    // Fallback response if speech processing fails
    throw new Error('Failed to process voice message');
  }
};

module.exports = {
  convertSpeechToText
};