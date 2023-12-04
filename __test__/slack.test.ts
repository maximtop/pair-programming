import { buildSimpleMessage } from '../src/slack';
import { Pair, TeamMember } from '../src/types';

describe('slack', () => {
    describe('buildSimpleMessage', () => {
        it('builds a simple message', () => {
            const pairs: Pair<TeamMember>[] = [
                [{ name: 'Max', id: '', slack: '' }, { name: 'Bob', id: '', slack: '' }],
                [{ name: 'John', id: '', slack: '' }, { name: 'Alice', id: '', slack: '' }],
            ];
            expect(buildSimpleMessage(pairs))
                .toBe('Current week pairs:\n1. Max & Bob\n2. John & Alice\ncc @extensions');
        });
    });
});
