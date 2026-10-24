// Entry point of web/dist/connect.js. The storage guard must stay the first
// import: ES modules evaluate in import order, and the kit touches
// localStorage as soon as it loads.
import './storage-guard';
import { start } from './widget';

start();
