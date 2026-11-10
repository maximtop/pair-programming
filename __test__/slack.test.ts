import { buildRichMessage, buildSimpleMessage } from '../src/slack';
import { Pair, TeamMember } from '../src/types';

describe('slack', () => {
    describe('buildSimpleMessage', () => {
        it('builds a simple message', () => {
            const pairs: Pair<TeamMember>[] = [
                [{ name: 'Max', id: '', slack: '' }, { name: 'Bob', id: '', slack: '' }],
                [{ name: 'John', id: '', slack: '' }, { name: 'Alice', id: '', slack: '' }],
            ];
            expect(buildSimpleMessage(pairs, []))
                .toBe('Current week pairs:\n1. Max & Bob\n2. John & Alice\ncc @extensions');
        });

        it('names the member left without a pair', () => {
            const pairs: Pair<TeamMember>[] = [
                [{ name: 'Max', id: '', slack: '' }, { name: 'Bob', id: '', slack: '' }],
            ];
            const unpaired: TeamMember[] = [{ name: 'Alice', id: '', slack: '' }];

            expect(buildSimpleMessage(pairs, unpaired))
                .toBe('Current week pairs:\n1. Max & Bob\nNo pair this week: Alice\ncc @extensions');
        });
    });

    describe('buildRichMessage', () => {
        const pairs: Pair<TeamMember>[] = [
            [{ name: 'Max', id: '', slack: '' }, { name: 'Bob', id: '', slack: '' }],
        ];

        const getTexts = (blocks: unknown[]): string[] => (blocks as { text?: { text: string } }[])
            .flatMap((block) => (block.text ? [block.text.text] : []));

        it('lists the pairs', () => {
            expect(getTexts(buildRichMessage(pairs, []))).toEqual([
                '*Current week pairs:*',
                '1. *Max* & *Bob*',
                'cc @extensions',
            ]);
        });

        it('names the member left without a pair after the pairs', () => {
            const unpaired: TeamMember[] = [{ name: 'Alice', id: '', slack: '' }];

            expect(getTexts(buildRichMessage(pairs, unpaired))).toEqual([
                '*Current week pairs:*',
                '1. *Max* & *Bob*',
                'No pair this week: Alice',
                'cc @extensions',
            ]);
        });
    });
});
