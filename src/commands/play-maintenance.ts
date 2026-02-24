import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

export function checkDiskSpace(): { available: number; percentage: number } {
  try {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    const percentage = parseInt(parts[4].replace('%', ''), 10);
    const available = parts[3];

    if (percentage > 90) {
      console.warn(`⚠️  Disk space warning: ${percentage}% used, ${available} available`);
    }

    return { available: parseFloat(available), percentage };
  } catch (error) {
    console.error('Could not check disk space:', error);
    return { available: 0, percentage: 0 };
  }
}

export function cleanupLogFiles() {
  try {
    const logFiles = ['eppu-out.log', 'eppu-error.log'];
    const maxSize = 10 * 1024 * 1024;

    logFiles.forEach(logFile => {
      const logPath = path.join(__dirname, '../../', logFile);
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        if (stats.size > maxSize) {
          console.log(`Log file ${logFile} is ${(stats.size / 1024 / 1024).toFixed(2)}MB, truncating...`);
          fs.truncateSync(logPath, 0);
        }
      }
    });
  } catch (error) {
    console.error('Error cleaning up log files:', error);
  }
}
