const details = () => ({
  id: 'Tdarr_Plugin_ceh002_OrderStreamsAndTranscode',
  Stage: 'Pre-processing',
  Name: 'Order streams and transcode file',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Order streams into video, audio (2ch, 6ch, 8ch), subtitles and then transcode file to hevc mp4.\n\n',
  Version: '1.0',
  Tags: 'pre-processing,ffmpeg',
  Inputs: [
    {
      name: 'lowerBound',
      type: 'number',
      defaultValue: 1000,
      inputUI: { type: 'text' },
      tooltip: "Enter the lower bound size in MB for files which should be processed. Files below this size won't be processed.",
    },
  ],
});

// Constants used for processing
const validCodecTypes = ['video', 'audio', 'subtitle'];
const invalidAudioFormats = ['truehd', 'flac', 'opus'];
const unsupportedAudioCodecs = ['pcm_s24le'];
const desiredStreams = [];
const undesiredStreams = [];
const validNodes = ['unraid_node', 'glg_node', 'mbp_node'];
const gpuNodes = ['unraid_node'];
const workingNode = process.env.nodeName.toLowerCase();
const response = { container: '.mp4', FFmpegMode: true, infoLog: '', preset: '', processFile: false, reQueueAfter: false };

/*
  This function is a helper to determine if the streams are in the desired order. Expected
  stream order is video, audio (by channel count asc), then subtitle streams last.
*/
const shouldReorderStreams = streams => {
  let audioCount = 0;
  let audio6Count = 0;
  let audio8Count = 0;
  let subtitleCount = 0;
  let reorderStreams = false;

  for (const stream of streams) {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    const audioChannels = stream?.channels || 0;

    if (codecType === 'video' && (audioCount !== 0 || subtitleCount !== 0)) {
      reorderStreams = true;
      response.infoLog += 'Video stream not first. Reordering.\n';
      break;
    }

    if (codecType === 'audio') {
      audioCount += 1;

      if (subtitleCount !== 0) {
        reorderStreams = true;
        response.infoLog += 'Audio stream not second. Reordering.\n';
        break;
      }

      if (audioChannels === 2 && (audio6Count !== 0 || audio8Count !== 0)) {
        reorderStreams = true;
        response.infoLog += 'Audio 2 channel stream not first. Reordering.\n';
        break;
      }

      if (audioChannels === 6) {
        audio6Count += 1;

        if (audio8Count !== 0) {
          reorderStreams = true;
          response.infoLog += 'Audio 6 channel stream not second. Reordering.\n';
          break;
        }
      }

      if (audioChannels === 8) {
        audio8Count += 1;
      }
    }

    if (codecType === 'subtitle') {
      subtitleCount += 1;
    }
  }

  return reorderStreams;
};

// This function is a helper to identify desired vs undesired streams for later processing and/or removal.
const getDesiredVsUndesiredStreams = streams => {
  streams.forEach((stream, index) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    const codecName = stream?.codec_name?.toLowerCase() || '';

    if (!validCodecTypes.includes(codecType)) {
      response.infoLog += `File contains invalid codec type '${codecType}'. Removing.\n`;
      undesiredStreams.push({ originalIndex: index, stream });
    } else if (codecType === 'video' && codecName === 'mjpeg') {
      response.infoLog += `File contains undesired 'mjpeg' video stream. Removing.\n`;
      undesiredStreams.push({ originalIndex: index, stream });
    } else {
      desiredStreams.push({ originalIndex: index, stream });
    }
  });
};

// This function sets the command args to reorder the file streams and remove any undesired streams as necessary.
const getOrderStreamsCommand = streams => {
  getDesiredVsUndesiredStreams(streams);

  const reorderStreams = shouldReorderStreams(streams);
  let ffmpegCommand = '';

  if (!reorderStreams && !undesiredStreams.length) {
    return ffmpegCommand;
  }

  const videoStreams = [];
  const audioStreams = [];
  const subtitleStreams = [];

  desiredStreams.forEach(({ stream }) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';

    if (codecType === 'video') {
      videoStreams.push(stream);
    } else if (codecType === 'audio') {
      audioStreams.push(stream);
    } else if (codecType === 'subtitle') {
      subtitleStreams.push(stream);
    }
  });

  const sortedAudioStreams = audioStreams.sort((a, b) => {
    const aAudioChannels = a?.stream?.channels || 0;
    const bAudioChannels = b?.stream?.channels || 0;
    return aAudioChannels - bAudioChannels;
  });

  videoStreams.forEach(({ originalIndex }) => {
    ffmpegCommand += `-map 0:${originalIndex} `;
  });

  sortedAudioStreams.forEach(({ originalIndex }) => {
    ffmpegCommand += `-map 0:${originalIndex} `;
  });

  subtitleStreams.forEach(({ originalIndex }) => {
    ffmpegCommand += `-map 0:${originalIndex} `;
  });

  undesiredStreams.forEach(({ originalIndex }) => {
    ffmpegCommand += `-map -0:${originalIndex} `;
  });

  return ffmpegCommand;
};

// This function sets the command args to ensure the input file will conform to the mp4 container of the output file.
const getMp4ConformCommands = (streams, fileContainer) => {
  let mp4ConformCommand = '';
  let genptsCommand = '';
  let audioTranscodeCommand = '';

  if (fileContainer === ('ts' || 'avi')) {
    genptsCommand += '-fflags +genpts';
  }

  streams.forEach((stream, index) => {
    const codecName = stream?.codec_name?.toLowerCase() || '';

    if (codecName === 'timed_id3') {
      response.infoLog += `File stream 0:${index} is a 'timed_id3' codec. Removing.\n`;
      mp4ConformCommand += `-map -0:${index} `;
      return;
    }

    if (invalidAudioFormats.includes(codecName) || unsupportedAudioCodecs.includes(codecName)) {
      response.infoLog += `Audio stream 0:${index} is a '${codecName}' codec. Re-encoding.\n`;
      audioTranscodeCommand += `-c:${index} aac -b:${index} 320k `;
    }
  });

  return { genptsCommand, mp4ConformCommand, audioTranscodeCommand };
};

// This function is a helper to convert sizes (in MB) into human readable MB/GB depending on value.
const getHumanReadableSize = size => {
  const humanReadableSize = size >= 1000 ? `${(size / 1000).toFixed(2)} GB` : `${size.toFixed(2)} MB`;
  return humanReadableSize;
};

/*
  This function determines if the file meets the following conditions: Is in HEVC format,
  is an mp4 file container, and current file size is <= the lowerBound input
*/
const shouldTranscodeFile = (file, lowerBound) => {
  const { container: fileContainer, file_size: fileSize, video_codec_name: videoCodec } = file;
  const fileSizeHumanReadable = getHumanReadableSize(fileSize);
  let shouldTranscode = false;

  if (videoCodec !== 'hevc') {
    response.infoLog += `File codec is currently ${videoCodec}. Setting command.\n`;
    shouldTranscode = true;
  } else if (fileContainer !== 'mp4') {
    response.infoLog += `File container is currently ${fileContainer}. Setting command.\n`;
    shouldTranscode = true;
  } else if (fileSize > lowerBound) {
    response.infoLog += `File is currently ${fileSizeHumanReadable}. Setting command.\n`;
    shouldTranscode = true;
  }

  return shouldTranscode;
};

// This function confirms that a valid (i.e. defined) node is processing the job and sets the appropriate command args.
const getWorkingNodeCommands = response => {
  let gpuWorkerCommand = '';
  let encoderSelectionCommand = '';

  if (!validNodes.includes(workingNode)) {
    throw new Error(`Unidentified node '${workingNode}' detected. Erroring!`);
  }

  response.infoLog += `Node '${workingNode}' detected. Setting command.\n`;

  if (gpuNodes.includes(workingNode)) {
    gpuWorkerCommand = '-hwaccel qsv -hwaccel_output_format qsv -qsv_device /dev/dri/renderD128';
    encoderSelectionCommand = 'hevc_qsv';
  } else {
    encoderSelectionCommand = 'libx265 -preset ultrafast';
  }

  return { gpuWorkerCommand, encoderSelectionCommand };
};

const plugin = (file, _librarySettings, inputs, _otherArguments) => {
  const lib = require('../methods/lib')();
  const { lowerBound } = lib.loadDefaultValues(inputs, details);
  const { container: fileContainer, fileMedium, ffProbeData } = file;
  const streams = ffProbeData?.streams || [];

  if (fileMedium !== 'video') {
    response.infoLog += `File is a ${fileMedium}, not a video. Skipping.\n`;
    return response;
  }

  if (!streams.length) {
    throw new Error(`Could not read file streams data. Error!`);
  }

  const orderStreamsCommand = getOrderStreamsCommand(streams);
  const { mp4ConformCommand, genptsCommand, audioTranscodeCommand } = getMp4ConformCommands(streams, fileContainer);
  const shouldTranscode = shouldTranscodeFile(file, lowerBound);

  if (!orderStreamsCommand && !mp4ConformCommand && !genptsCommand && !audioTranscodeCommand && !shouldTranscode) {
    response.infoLog += `File meets desired output conditions. Skipping.\n`;
    return response;
  }

  const { gpuWorkerCommand, encoderSelectionCommand } = getWorkingNodeCommands(response);
  response.processFile = true;
  response.preset = `${gpuWorkerCommand} ${genptsCommand}, -map 0 ${orderStreamsCommand} ${mp4ConformCommand} -c copy ${audioTranscodeCommand} -c:v ${encoderSelectionCommand} -crf 25 -x265-params profile=auto:level=auto -strict -2 -max_muxing_queue_size 9999`;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
