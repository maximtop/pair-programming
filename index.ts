import { main } from './src';

(async (): Promise<void> => {
    try {
        await main({ dryRun: process.argv.includes('--dry-run') });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.log(e);
        process.exit(1);
    }
})();
