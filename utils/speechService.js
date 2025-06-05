const sdk = require('microsoft-cognitiveservices-speech-sdk');
const winston = require('winston');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const getAudioDuration = require('get-audio-duration');

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
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
    "45000" 
  );
  return speechConfig;
};

const convertToWav = (audioBuffer) => {
  return new Promise((resolve, reject) => {
    const inputStream = Readable.from(audioBuffer);
    const outputPath = `/tmp/audio_${Date.now()}.wav`;

    logger.debug('Converting audio to WAV', { bufferSize: audioBuffer.length });

    ffmpeg(inputStream)
      .inputFormat('ogg')
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('error', (err) => {
        logger.error('FFmpeg conversion error', { error: err.message });
        reject(new Error('Audio conversion failed'));
      })
      .on('end', async () => {
        logger.info('Audio converted to WAV', { outputPath });
        if (!fs.existsSync(outputPath)) {
          logger.error('WAV file not created', { outputPath });
          reject(new Error('WAV file creation failed'));
          return;
        }

        const wavBuffer = fs.readFileSync(outputPath);
        try {
          const duration = await getAudioDuration.fromFile(outputPath);
          fs.unlinkSync(outputPath); // Clean up
          resolve({ wavBuffer, duration });
        } catch (err) {
          fs.unlinkSync(outputPath);
          reject(new Error('Failed to get audio duration'));
        }
      })
      .save(outputPath);
  });
};

const withTimeout = (promise, ms) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Speech recognition timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
};

exports.convertSpeechToText = async (audioBuffer, retries = 2) => {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      logger.debug('Starting speech-to-text conversion', { attempt, bufferSize: audioBuffer.length });

      // Convert audio to WAV format
      const { wavBuffer, duration } = await convertToWav(audioBuffer);
logger.debug('Audio converted to WAV', { wavSize: wavBuffer.length, duration });

if (duration < 0.5) {
  logger.warn('Audio too short or silent for transcription', { duration });
  throw new Error('Audio too short or silent');
}

      // Validate WAV buffer
      if (wavBuffer.length < 44) { // Minimum WAV header size
        logger.error('Invalid WAV buffer', { size: wavBuffer.length });
        throw new Error('Invalid WAV file');
      }

      const speechConfig = createSpeechClient();
      const audioConfig = sdk.AudioConfig.fromWavFileInput(wavBuffer);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      logger.debug('Speech recognizer initialized');

      const recognitionPromise = new Promise((resolve, reject) => {
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
              default:
                logger.error('Unknown recognition result', { reason: result.reason });
                reject(new Error('Unknown recognition error'));
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

      return await withTimeout(recognitionPromise, 10000); // 10s timeout
    } catch (error) {
      logger.error('Speech-to-text attempt failed', { attempt, error: error.message, stack: error.stack });
      if (attempt > retries) {
        throw new Error(`Speech-to-text failed after ${retries} retries: ${error.message}`);
      }
      logger.info('Retrying speech-to-text', { attempt });
    }
  }
};