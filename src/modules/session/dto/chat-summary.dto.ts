import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ChatKind } from '../../../engine/identity/wa-id';

const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

/** OpenAPI mirror of the engine `ChatSummary` (documentation only; the runtime returns the interface). */
export class ChatSummaryDto {
  @ApiProperty({ example: '628111@c.us' })
  id!: string;

  @ApiProperty({ example: 'Alice' })
  name!: string;

  @ApiProperty({ description: 'Retained for back-compat; true for @g.us chats.', example: false })
  isGroup!: boolean;

  @ApiProperty({ enum: CHAT_KINDS, description: 'User-facing chat kind.', example: 'individual' })
  kind!: ChatKind;

  @ApiProperty({ example: 1 })
  unreadCount!: number;

  @ApiProperty({ description: 'Unix seconds of the last activity.', example: 1700000010 })
  timestamp!: number;

  @ApiPropertyOptional({ example: 'hi' })
  lastMessage?: string;

  @ApiProperty({ description: 'Archived state, as set via POST /sessions/{sessionId}/chats/archive.', example: false })
  archived!: boolean;

  @ApiProperty({ description: 'Pinned state, as set via POST /sessions/{sessionId}/chats/pin.', example: false })
  pinned!: boolean;

  @ApiProperty({
    description:
      'Whether the chat is muted right now, as set via POST /sessions/{sessionId}/chats/mute. A ' +
      'boolean rather than the expiry: whatsapp-web.js derives the verdict itself, and Baileys ' +
      'reports only a muteEndTime whose unit its type does not fix, so an expiry would be a units ' +
      'question at every call site.',
    example: false,
  })
  muted!: boolean;
}
