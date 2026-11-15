// Icons of the Upload page, in the house style: chamfered outlines in currentColor and one
// accent stroke. On a coloured surface set --sx-icon-accent so the accent stays visible.
import { RawIcon } from './RawIcon.jsx';
import slidersRaw from './svg/media-sliders.svg?raw';
import checkRaw from './svg/media-check.svg?raw';
import cloudRaw from './svg/media-cloud.svg?raw';
import deviceRaw from './svg/media-device.svg?raw';
import downloadRaw from './svg/media-download.svg?raw';
import redoRaw from './svg/media-redo.svg?raw';
import cubeRaw from './svg/media-cube.svg?raw';
import depthRaw from './svg/media-depth.svg?raw';
import stackRaw from './svg/media-stack.svg?raw';
import squareRaw from './svg/media-square.svg?raw';
import clockRaw from './svg/media-clock.svg?raw';
import activityRaw from './svg/media-activity.svg?raw';
import closeRaw from './svg/media-close.svg?raw';
import trashRaw from './svg/media-trash.svg?raw';
import alertRaw from './svg/media-alert.svg?raw';
import sendRaw from './svg/media-send.svg?raw';

const icon = (src) => function MediaIcon({ className = 'sx-media-icon', ...props }) {
  return <RawIcon src={src} className={className} {...props} />;
};

export const SlidersIcon = icon(slidersRaw);
export const CheckIcon = icon(checkRaw);
export const CloudIcon = icon(cloudRaw);
export const DeviceIcon = icon(deviceRaw);
export const DownloadIcon = icon(downloadRaw);
export const RedoIcon = icon(redoRaw);
export const CubeIcon = icon(cubeRaw);
export const DepthIcon = icon(depthRaw);
export const StackIcon = icon(stackRaw);
export const SquareIcon = icon(squareRaw);
export const ClockIcon = icon(clockRaw);
export const ActivityIcon = icon(activityRaw);
export const CloseIcon = icon(closeRaw);
export const TrashIcon = icon(trashRaw);
export const AlertIcon = icon(alertRaw);
export const SendIcon = icon(sendRaw);
