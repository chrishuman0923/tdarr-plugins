const details = () => ({
  id: 'Tdarr_Plugin_ceh003_NewFileSizeCheck',
  Stage: 'Post-processing',
  Name: 'Check new file size',
  Type: 'Video',
  Operation: 'Transcode',
  Description: 'Throws an error if the new file is not within a percentage range of the original file size.\n\n',
  Version: '1.00',
  Tags: '',
  Inputs: [
    {
      name: 'upperBoundPercentage',
      type: 'number',
      defaultValue: 110,
      inputUI: { type: 'text' },
      tooltip: 'Enter the upper bound percentage as a number. Files above this size will error.',
    },
    {
      name: 'lowerBoundPercentage',
      type: 'number',
      defaultValue: 30,
      inputUI: { type: 'text' },
      tooltip: 'Enter the lower bound percentage as a number. Files below this size will error.',
    },
  ],
});

// Constants used for processing
const response = { FFmpegMode: true, infoLog: '', preset: '', processFile: false, reQueueAfter: false };

// This function is a helper to convert sizes (in MB) into human readable MB/GB depending on value.
const getHumanReadableSize = size => {
  const humanReadableSize = size >= 1000 ? `${(size / 1000).toFixed(2)} GB` : `${size.toFixed(2)} MB`;
  return humanReadableSize;
};

const plugin = (file, _librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  const { upperBoundPercentage, lowerBoundPercentage } = lib.loadDefaultValues(inputs, details);
  const { file_size: fileSize } = file;
  const { file_size: originalFileSize } = otherArguments.originalLibraryFile;

  const newFileSize = !isNaN(fileSize) ? Number(fileSize) : 0;
  const origFileSize = !isNaN(originalFileSize) ? Number(originalFileSize) : 0;
  const fileSizeHumanReadable = getHumanReadableSize(newFileSize);
  const origFileSizeHumanReadable = getHumanReadableSize(origFileSize);
  const ratio = ((newFileSize / origFileSize) * 100).toFixed(2);
  const upperBoundLimitExeeded = newFileSize > (upperBoundPercentage / 100) * origFileSize;
  const lowerBoundLimitExeeded = newFileSize < (lowerBoundPercentage / 100) * origFileSize;

  response.infoLog += `New file is ${fileSizeHumanReadable} (${ratio}%) of original file size ${origFileSizeHumanReadable}.`;
  let message = '';

  if (upperBoundLimitExeeded) {
    message += `New file size exceeds upper limit of '${upperBoundPercentage}%'!`;
  } else if (lowerBoundLimitExeeded) {
    message += `New file size exceeds lower limit of '${lowerBoundPercentage}%'!`;
  }

  if (upperBoundLimitExeeded || lowerBoundLimitExeeded) {
    response.infoLog += `${message}. Erroring.\n`;
    throw new Error(message);
  }

  return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
