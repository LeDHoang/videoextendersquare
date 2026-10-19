import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
// Three.js scenes need a real GL backend in headless Chrome.
Config.setChromiumOpenGlRenderer('angle');
