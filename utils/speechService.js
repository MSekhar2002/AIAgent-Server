const sdk = require('microsoft-cognitiveservices-speech-sdk');
const winston = require('winston');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; // Correct package
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

// Logger setup
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/speechService.log' }),
    new winston.transports.Console()
  ]
});

const createSpeechClient = () => {
  const subscriptionKey = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!subscriptionKey || !region) {
    logger.error('Azure Speech credentials missing');
    throw new Error('Azure Speech credentials not configured');
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, region);
  speechConfig.speechRecognitionLanguage = 'en-US';
  return speechConfig;
};

const convertToWav = (audioBuffer) => {
  return new Promise((resolve, reject) => {
    const inputStream = Readable.from(audioBuffer);
    const outputPath = `/tmp/audio_${Date.now()}.wav`;

    logger.debug('Converting audio to WAV', { bufferSize: audioBuffer.length });

    ffmpeg(inputStream)
      .inputFormat('ogg') // WhatsApp voice messages are typically OGG
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('error', (err) => {
        logger.error('FFmpeg conversion error', { error: err.message });
        reject(new Error('Audio conversion failed'));
      })
      .on('end', () => {
        logger.info('Audio converted to WAV', { outputPath });
        const wavBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath); // Clean up
        resolve(wavBuffer);
      })
      .save(outputPath);
  });
};

exports.convertSpeechToText = async (audioBuffer) => {
  try {
    logger.debug('Starting speech-to-text conversion', { bufferSize: audioBuffer.length });

    // Convert audio to WAV format
    const wavBuffer = await convertToWav(audioBuffer);
    logger.debug('Audio converted to WAV', { wavSize: wavBuffer.length });

    const speechConfig = createSpeechClient();
    const audioConfig = sdk.AudioConfig.fromWavFileInput(wavBuffer);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    logger.debug('Speech recognizer initialized');

    return new Promise((resolve, reject) => {
      recognizer.recognizeOnceAsync(
        result => {
          switch (result.reason) {
            case sdk.ResultReason.RecognizedSpeech:
              logger.info('Speech recognized', { text: result.text });
              resolve(result.text);
              break;
            case sdk.ResultReason.NoMatch:
              logger.warn('No speech recognized');
              reject(new Error('No speech could be recognized'));
              break;
            case sdk.ResultReason.Canceled:
              const cancellation = sdk.CancellationDetails.fromResult(result);
              logger.error('Speech recognition canceled', {
                reason: cancellation.reason,
                errorCode: cancellation.ErrorCode,
                errorDetails: cancellation.errorDetails
              });
              reject(new Error(`Speech recognition canceled: ${cancellation.errorDetails}`));
              break;
          }
          recognizer.close();
        },
        err => {
          logger.error('Speech recognition error', { error: err.message });
          recognizer.close();
          reject(err);
        }
      );
    });
  } catch (error) {
    logger.error('Speech-to-text conversion error', { error: error.message, stack: error.stack });
    throw error;
  }
};