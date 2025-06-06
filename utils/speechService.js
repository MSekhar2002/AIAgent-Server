const sdk = require('microsoft-cognitiveservices-speech-sdk');
const winston = require('winston');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { Readable, PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

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

  // Extend silence timeout to avoid premature timeout
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
    "60000" // 60 seconds
  );

  // Extend end silence timeout
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
    "3000" // 3 seconds
  );

  return speechConfig;
};

const withTimeout = (promise, ms) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Speech recognition timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
};

// Fixed function to convert audio to WAV
const convertToWav = (audioBuffer) => {
  return new Promise((resolve, reject) => {
    logger.debug('Starting audio conversion', { bufferSize: audioBuffer.length });
    
    // Create temporary file paths
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const inputPath = path.join(tempDir, `input_${Date.now()}.ogg`);
    const outputPath = path.join(tempDir, `output_${Date.now()}.wav`);
    
    try {
      // Write buffer to temporary file
      fs.writeFileSync(inputPath, audioBuffer);
      
      ffmpeg(inputPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .format('wav')
        .on('start', (commandLine) => {
          logger.debug('FFmpeg started', { command: commandLine });
        })
        .on('progress', (progress) => {
          logger.debug('FFmpeg progress', { percent: progress.percent });
        })
        .on('end', () => {
          try {
            logger.debug('FFmpeg conversion completed');
            const wavBuffer = fs.readFileSync(outputPath);
            
            // Cleanup temp files
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            
            logger.debug('WAV conversion successful', { wavSize: wavBuffer.length });
            resolve(wavBuffer);
          } catch (readErr) {
            logger.error('Error reading converted WAV file', { error: readErr.message });
            reject(readErr);
          }
        })
        .on('error', (err) => {
          logger.error('FFmpeg conversion error', { error: err.message });
          
          // Cleanup temp files on error
          try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch (cleanupErr) {
            logger.warn('Failed to cleanup temp files', { error: cleanupErr.message });
          }
          
          reject(err);
        })
        .save(outputPath);
        
    } catch (writeErr) {
      logger.error('Error writing input file', { error: writeErr.message });
      reject(writeErr);
    }
  });
};

// Alternative stream-based conversion (if file-based doesn't work)
const convertToWavStream = (audioBuffer) => {
  return new Promise((resolve, reject) => {
    logger.debug('Starting stream-based audio conversion', { bufferSize: audioBuffer.length });
    
    const inputStream = new Readable({
      read() {
        this.push(audioBuffer);
        this.push(null); // End of stream
      }
    });
    
    const outputChunks = [];
    const outputStream = new PassThrough();
    
    outputStream.on('data', (chunk) => {
      outputChunks.push(chunk);
    });
    
    outputStream.on('end', () => {
      const wavBuffer = Buffer.concat(outputChunks);
      logger.debug('Stream conversion successful', { wavSize: wavBuffer.length });
      resolve(wavBuffer);
    });
    
    outputStream.on('error', (err) => {
      logger.error('Output stream error', { error: err.message });
      reject(err);
    });
    
    ffmpeg(inputStream)
      .inputFormat('ogg') // Explicitly specify input format
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('start', (commandLine) => {
        logger.debug('FFmpeg stream started', { command: commandLine });
      })
      .on('progress', (progress) => {
        logger.debug('FFmpeg stream progress', { percent: progress.percent });
      })
      .on('end', () => {
        logger.debug('FFmpeg stream conversion completed');
        outputStream.end();
      })
      .on('error', (err) => {
        logger.error('FFmpeg stream conversion error', { error: err.message });
        reject(err);
      })
      .pipe(outputStream, { end: false });
  });
};

// Enhanced speech-to-text function with better error handling
exports.convertSpeechToText = async (audioBuffer, retries = 2) => {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      logger.debug('Starting speech-to-text conversion', { 
        attempt, 
        bufferSize: audioBuffer.length,
        bufferType: typeof audioBuffer
      });

      // Enhanced validation
      if (!audioBuffer || audioBuffer.length < 100) {
        logger.error('Invalid or too small audio buffer', { 
          size: audioBuffer?.length || 0,
          type: typeof audioBuffer
        });
        throw new Error('Invalid audio buffer');
      }

      // Log buffer header to help identify format
      const headerHex = audioBuffer.slice(0, 16).toString('hex');
      logger.debug('Audio buffer header', { headerHex });

      // Try file-based conversion first, fall back to stream-based
      let wavBuffer;
      try {
        wavBuffer = await convertToWav(audioBuffer);
      } catch (convErr) {
        logger.warn('File-based conversion failed, trying stream-based', { error: convErr.message });
        wavBuffer = await convertToWavStream(audioBuffer);
      }

      if (!wavBuffer || wavBuffer.length < 100) {
        throw new Error('WAV conversion produced empty or invalid buffer');
      }

      logger.debug('Audio converted to WAV', { wavSize: wavBuffer.length });

      const speechConfig = createSpeechClient();
      
      // Create a push stream for the WAV buffer
      const pushStream = sdk.AudioInputStream.createPushStream();
      pushStream.write(wavBuffer);
      pushStream.close();
      
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      logger.debug('Speech recognizer initialized for WAV');

      const recognitionPromise = new Promise((resolve, reject) => {
        // Set up event handlers
        recognizer.recognized = (s, e) => {
          if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
            logger.info('Speech recognized during processing', { text: e.result.text });
          }
        };

        recognizer.canceled = (s, e) => {
          logger.error('Speech recognition was canceled', {
            reason: e.reason,
            errorCode: e.errorCode,
            errorDetails: e.errorDetails
          });
        };

        recognizer.recognizeOnceAsync(
          result => {
            try {
              switch (result.reason) {
                case sdk.ResultReason.RecognizedSpeech:
                  logger.info('Speech recognized successfully', { 
                    text: result.text,
                    confidence: result.properties?.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
                  });
                  resolve(result.text);
                  break;
                case sdk.ResultReason.NoMatch:
                  logger.warn('No speech recognized in audio');
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
            } finally {
              recognizer.close();
            }
          },
          err => {
            logger.error('Speech recognition error', { error: err.message });
            recognizer.close();
            reject(err);
          }
        );
      });

      const result = await withTimeout(recognitionPromise, 15000); // 15s timeout
      
      if (!result || result.trim().length === 0) {
        throw new Error('Empty transcription result');
      }
      
      return result;
      
    } catch (error) {
      logger.error('Speech-to-text attempt failed', { 
        attempt, 
        error: error.message, 
        stack: error.stack 
      });
      
      if (attempt > retries) {
        throw new Error(`Speech-to-text failed after ${retries + 1} attempts: ${error.message}`);
      }
      
      logger.info('Retrying speech-to-text', { attempt: attempt + 1 });
      
      // Add delay between retries
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
};