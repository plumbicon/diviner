import { Strategy } from './strategy.js';
import { pathToFileURL } from 'url';
import { resolve } from 'path';

/**
 * Загрузить класс стратегии из файла
 */
export async function loadStrategy(strategyPath) {
  const absolutePath = resolve(strategyPath);
  
  try {
    const moduleUrl = pathToFileURL(absolutePath).href;
    const module = await import(moduleUrl);
    
    for (const [name, exported] of Object.entries(module)) {
      if (typeof exported === 'function' && exported.prototype) {
        if (exported.prototype instanceof Strategy || exported.name === 'Strategy') {
          if (exported !== Strategy && exported.prototype.init && exported.prototype.next) {
            return exported;
          }
        }
      }
    }
    
    throw new TypeError(`No class inheriting from Strategy found in ${strategyPath}`);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load strategy from ${strategyPath}: ${error.message}`);
    }
    throw error;
  }
}
