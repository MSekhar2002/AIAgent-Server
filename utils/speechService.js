const axios = require('axios');
const { SpeechConfig, AudioConfig, SpeechRecognizer, ResultReason } = require('microsoft-cognitiveservices-speech-sdk');

/**
 * Convert speech to text using Azure Speech Services
 * @param {string} audioUrl - URL to the audio file
 * @returns {Promise<string>} - Transcribed text
 */
/**
 * Convert speech to text using Azure Speech Services
 * @param {Buffer|ArrayBuffer} audioData - Binary audio data
 * @returns {Promise<string>} - Transcribed text
 */
const convertSpeechToText = async (audioData) => {
  try {
    console.log('Processing voice message with Azure Speech Services');
    
    // Configure speech service
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    
    if (!speechKey || !speechRegion) {
      throw new Error('Azure Speech Services credentials not configured');
    }
    
    // Create speech configuration with enhanced settings
    const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = 'en-US';
    
    // Enable detailed logging
    speechConfig.setProperty('SpeechServiceConnection_LogLevel', '4'); // Detailed
    
    // Set audio format for better recognition
    speechConfig.setProperty('AudioProcessingOptions_DtxEnabled', '0');
    speechConfig.setProperty('SpeechServiceConnection_EndSilenceTimeoutMs', '1000');
    speechConfig.setProperty('SpeechServiceConnection_InitialSilenceTimeoutMs', '1000');
    
    // Create audio configuration from the audio data
    const pushStream = AudioConfig.createPushStream();
    
    // Log audio data information
    console.log('Audio data received, size:', audioData.byteLength || audioData.length, 'bytes');
    
    // Write audio data to the push stream
    pushStream.write(audioData);
    pushStream.close();
    
    const audioConfig = AudioConfig.fromStreamInput(pushStream);
    
    // Create speech recognizer with enhanced configuration
    const recognizer = new SpeechRecognizer(speechConfig, audioConfig);
    
    // Log recognition events for debugging
    recognizer.recognized = (sender, event) => {
      console.log(`RECOGNIZED: ${event.result.text}`);
    };
    
    recognizer.canceled = (sender, event) => {
      console.log(`CANCELED: Reason=${event.reason}`);
      if (event.reason === CancellationReason.Error) {
        console.log(`CANCELED: ErrorCode=${event.errorCode}`);
        console.log(`CANCELED: ErrorDetails=${event.errorDetails}`);
      }
    };
    
    // Start recognition with enhanced error handling
    return new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        result => {
          recognizer.close();
          if (result.reason === ResultReason.RecognizedSpeech) {
            console.log('Speech recognized successfully:', result.text);
            resolve(result.text);
          } else {
            console.error('Speech recognition failed with reason:', result.reason);
            reject(new Error(`Speech recognition failed: ${result.reason}`));
          }
        },
        err => {
          console.error('Speech recognition error:', err);
          recognizer.close();
          reject(err);
        }
      );
    });
  } catch (error) {
    console.error('Speech-to-text conversion error:', error.message, error.stack);
    
    // Fallback response if speech processing fails
    throw new Error('Failed to process voice message: ' + error.message);
  }
};

module.exports = {
  convertSpeechToText
};