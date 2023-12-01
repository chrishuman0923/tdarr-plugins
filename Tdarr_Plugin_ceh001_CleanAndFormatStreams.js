const details = () => ({
  id: 'Tdarr_Plugin_ceh001_CleanAndFormatStreams',
  Stage: 'Pre-processing',
  Name: 'Cleans and formats file streams',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'This plugin removes data streams and filters/formats audio/subtitle streams.\n\n',
  Version: '1.0',
  Tags: 'pre-processing,ffmpeg',
  Inputs: [],
});

// Constants used for processing
const validAudioLanguages = ['eng', 'und'];
const validSubtitleLanguages = ['eng'];
const unsupportedCodecs = ['pcm_s24le'];
const invalidMp4SubtitleFormats = ['hdmv_pgs_subtitle', 'eia_608', 'subrip'];
const validNodes = ['unraid_node', 'glg_node', 'mbp_node'];
const gpuNodes = ['unraid_node'];
const workingNode = process.env.nodeName.toLowerCase();
const response = { container: '', FFmpegMode: true, infoLog: '', preset: '', processFile: false, reQueueAfter: false };

// This function identifies and sets the appropriate command args to remove all data streams from the output file.
const getDataStreamsCommand = streams => {
  let ffmpegCommand = '';

  streams.forEach((stream, index) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    if (codecType !== 'data') return;

    ffmpegCommand += `-map -0:${index} `;
    response.processFile = true;
  });

  return ffmpegCommand;
};

/*
  This function identifies and sets the appropriate command args to remove all foreign audio streams and
  re-tags all undefined audio streams with 'eng' language metadata for the output file.
*/
const getAudioStreamsCommand = streams => {
  let ffmpegCommand = '';
  let audioStreamsRemoved = 0;

  streams.forEach((stream, index) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';

    if (codecType !== 'audio') return;

    const codecName = stream?.codec_name?.toLowerCase() || '';
    const streamTags = stream?.tags || {};
    const hasTags = Object.keys(streamTags).length > 0;
    const title = streamTags?.title?.toLowerCase() || '';
    const language = streamTags?.language?.toLowerCase() || '';
    let removeTrack = false;

    if (unsupportedCodecs.includes(codecName)) {
      response.infoLog += `Audio stream 0:${index} is unsupported codec '${codecName}'. Removing.\n`;
      removeTrack = true;
    } else if (language && !validAudioLanguages.includes(language)) {
      response.infoLog += `Audio stream 0:${index} has unwanted language tag '${language}'. Removing.\n`;
      removeTrack = true;
    } else if (title.includes('commentary') || title.includes('description')) {
      response.infoLog += `Audio stream 0:${index} detected as being commentary. Removing.\n`;
      removeTrack = true;
    }

    if (removeTrack) {
      audioStreamsRemoved += 1;
      ffmpegCommand += `-map -0:${index} `;
      return;
    }

    if (language.includes('und')) {
      response.infoLog += `Audio stream 0:${index} has 'und' language tag. Re-tagging as 'en'.\n`;
      ffmpegCommand += `-metadata:s:a:${index} language=en `;
    } else if (!hasTags || !language) {
      response.infoLog += `Audio stream 0:${index} has no defined language. Tagging as 'en'.\n`;
      ffmpegCommand += `-metadata:s:a:${index} language=en `;
    }
  });

  const audioStreams = streams.filter(stream => {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    return codecType === 'audio';
  });

  if (audioStreamsRemoved === audioStreams.length) {
    response.infoLog += 'All audio streams would be removed. Reseting command.\n';
    ffmpegCommand = '';
  }

  if (ffmpegCommand) {
    response.processFile = true;
  }

  return ffmpegCommand;
};

/*
  This function identifies and sets the appropriate command args to remove all foreign subtitle streams and
  any subtitle streams that will not be compatible with the mp4 container of the final output file.
*/
const getSubtitleStreamsCommand = streams => {
  let ffmpegCommand = '';

  streams.forEach((stream, index) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    if (codecType !== 'subtitle') return;

    const codecName = stream?.codec_name?.toLowerCase() || '';
    const streamTags = stream?.tags || {};
    const hasTags = Object.keys(streamTags).length > 0;
    const language = streamTags?.language?.toLowerCase() || '';
    let removeTrack = false;

    if (language && !validSubtitleLanguages.includes(language)) {
      response.infoLog += `Subtitle stream 0:${index} has unwanted language tag '${language}'. Removing.\n`;
      removeTrack = true;
    } else if (!hasTags || !language) {
      response.infoLog += `Subtitle stream 0:${index} has no defined language. Removing.\n`;
      removeTrack = true;
    } else if (invalidMp4SubtitleFormats.includes(codecName)) {
      response.infoLog += `Subtitle stream 0:${index} contains invalid subtitle format '${codecName}'. Removing.\n`;
      removeTrack = true;
    }

    if (removeTrack) {
      ffmpegCommand += `-map -0:${index} `;
    }
  });

  if (ffmpegCommand) {
    response.processFile = true;
  }

  return ffmpegCommand;
};

/*
  This function identifies and sets the appropriate command args to remove all title metadata from the file
  as well as any title metadata in the individual video streams.
*/
const getTitleMetadataCommand = (streams, fileMeta) => {
  let ffmpegCommand = '';

  if (fileMeta?.Title) {
    response.infoLog += 'File contains title metadata. Removing.\n';
    ffmpegCommand += '-metadata title=  ';
  }

  streams.forEach((stream, index) => {
    const codecType = stream?.codec_type?.toLowerCase() || '';
    const title = stream?.tags?.title?.toLowerCase() || '';

    if (codecType !== 'video' || !title) return;

    ffmpegCommand += `-metadata:s:${index} title=  `;
    response.infoLog += `Video stream 0:${index} contains title metadata. Removing.\n`;
    response.processFile = true;
  });

  return ffmpegCommand;
};

// This function confirms that a valid (i.e. defined) node is processing the job and sets the appropriate command args.
const getWorkingNodeCommand = () => {
  let ffmpegCommand = '';

  if (!validNodes.includes(workingNode)) {
    throw new Error(`Unidentified node '${workingNode}' detected. Erroring!`);
  }

  response.infoLog += `Node '${workingNode}' detected. Setting command.\n`;

  if (gpuNodes.includes(workingNode)) {
    ffmpegCommand += '-hwaccel qsv -hwaccel_output_format qsv -qsv_device /dev/dri/renderD128';
  }

  return ffmpegCommand;
};

const plugin = (file, _librarySettings, _inputs, _otherArguments) => {
  const { container: fileContainer, fileMedium, ffProbeData, meta } = file;
  const streams = ffProbeData?.streams || [];
  const fileMeta = meta || {};

  response.container = `.${fileContainer}`;

  if (fileMedium !== 'video') {
    response.infoLog += `File is a '${fileMedium}', not a video. Skipping.\n`;
    return response;
  }

  if (!streams.length) {
    throw new Error(`Could not read file streams data. Error!`);
  }

  const dataStreamsCommand = getDataStreamsCommand(streams);
  const audioStreamsCommand = getAudioStreamsCommand(streams);
  const subtitleStreamsCommand = getSubtitleStreamsCommand(streams);
  const titleMetadataCommand = getTitleMetadataCommand(streams, fileMeta);

  if (!response.processFile) {
    response.infoLog += `File does not contain any undesired or un-tagged streams. Skipping.\n`;
    return response;
  }

  const workingNodeCommand = getWorkingNodeCommand();
  response.preset = `${workingNodeCommand}, -map 0 ${dataStreamsCommand} ${audioStreamsCommand} ${subtitleStreamsCommand} ${titleMetadataCommand} -c copy -strict -2 -max_muxing_queue_size 9999`;

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
