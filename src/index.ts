import { addPairSessions, getPairs } from './notion';
import { publishToSlack } from './slack';

export const main = async (): Promise<void> => {
    const pairs = await getPairs();
    await addPairSessions(pairs);
    await publishToSlack(pairs);
};
