import { copy } from "../../helpers/object";
import { InputMedia } from "../../layer";
import { logger, LogLevels } from "../logger";
import apiManager from "../mtproto/mtprotoworker";
import { MOUNT_CLASS_TO } from "../mtproto/mtproto_config";
import { RichTextProcessor } from "../richtextprocessor";
import rootScope from "../rootScope";
import apiUpdatesManager from "./apiUpdatesManager";
import appMessagesManager from './appMessagesManager';
import appPeersManager from './appPeersManager';
import appUsersManager from "./appUsersManager";

export type PollAnswer = {
  _: 'pollAnswer',
  text: string,
  option: Uint8Array
};

export type PollAnswerVoters = {
  _: 'pollAnswerVoters',
  flags: number,
  option: Uint8Array,
  voters: number,

  pFlags: Partial<{
    chosen: true,
    correct: true
  }>
};

export type PollResult = {
  _: 'pollAnswerVoters',
  flags: number,
  option: Uint8Array,
  voters: number,

  pFlags?: Partial<{chosen: true, correct: true}>
};

export type PollResults = {
  _: 'pollResults',
  flags: number,
  results?: Array<PollResult>,
  total_voters?: number,
  recent_voters?: number[],
  solution?: string,
  solution_entities?: any[],

  pFlags: Partial<{
    min: true
  }>,
};

export type Poll = {
  _: 'poll',
  question: string,
  id: string,
  answers: Array<PollAnswer>,
  close_period?: number,
  close_date?: number

  pFlags?: Partial<{
    closed: true,
    public_voters: true,
    multiple_choice: true,
    quiz: true
  }>,
  rQuestion?: string,
  rReply?: string,
  chosenIndexes?: number[]
};

class AppPollsManager {
  public polls: {[id: string]: Poll} = {};
  public results: {[id: string]: PollResults} = {};

  private log = logger('POLLS', LogLevels.error);

  constructor() {
    rootScope.on('apiUpdate', (e) => {
      let update = e.detail;
      
      this.handleUpdate(update);
    });
  }
  
  public handleUpdate(update: any) {
    switch(update._) {
      case 'updateMessagePoll': { // when someone voted, we too
        this.log('updateMessagePoll:', update);

        let poll: Poll = update.poll || this.polls[update.poll_id];
        if(!poll) {
          break;
        }

        poll = this.savePoll(poll, update.results);
        rootScope.broadcast('poll_update', {poll, results: update.results});
        break;
      }

      default:
        break;
    }
  }

  public savePoll(poll: Poll, results: PollResults) {
    const id = poll.id;
    if(this.polls[id]) {
      poll = Object.assign(this.polls[id], poll);
      this.saveResults(poll, results);
      return poll;
    }

    this.polls[id] = poll;

    poll.rQuestion = RichTextProcessor.wrapEmojiText(poll.question);
    poll.rReply = RichTextProcessor.wrapEmojiText('📊') + ' ' + (poll.rQuestion || 'poll');
    poll.chosenIndexes = [];
    this.saveResults(poll, results);
    return poll;
  }

  public saveResults(poll: Poll, results: PollResults) {
    this.results[poll.id] = results;

    if(!results.pFlags.min) { // ! https://core.telegram.org/constructor/pollResults - min
      poll.chosenIndexes.length = 0;
      if(results?.results?.length) {
        results.results.forEach((answer, idx) => {
          if(answer.pFlags?.chosen) {
            poll.chosenIndexes.push(idx);
          }
        });
      }
    }
  }

  public getPoll(pollID: string): {poll: Poll, results: PollResults} {
    return {
      poll: this.polls[pollID], 
      results: this.results[pollID]
    };
  }

  public getInputMediaPoll(poll: Poll, correctAnswers?: Uint8Array[], solution?: string): InputMedia.inputMediaPoll {
    let solution_entities: any[];
    if(solution) {
      solution_entities = [];
      solution = RichTextProcessor.parseMarkdown(solution, solution_entities);
    }

    return {
      _: 'inputMediaPoll',
      poll,
      correct_answers: correctAnswers,
      solution,
      solution_entities
    };
  }

  public sendVote(mid: number, optionIDs: number[]): Promise<void> {
    const message = appMessagesManager.getMessage(mid);
    const poll: Poll = message.media.poll;

    const options: Uint8Array[] = optionIDs.map(index => {
      return poll.answers[index].option;
    });
    
    const inputPeer = appPeersManager.getInputPeerByID(message.peerID);
    const messageID = message.id;

    if(mid < 0) {
      return appMessagesManager.invokeAfterMessageIsSent(mid, 'sendVote', (mid) => {
        this.log('invoke sendVote callback');
        return this.sendVote(mid, optionIDs);
      });
    }

    return apiManager.invokeApi('messages.sendVote', {
      peer: inputPeer,
      msg_id: messageID,
      options
    }).then(updates => {
      this.log('sendVote updates:', updates);
      apiUpdatesManager.processUpdateMessage(updates);
    });
  }

  public getResults(mid: number) {
    const message = appMessagesManager.getMessage(mid);
    const inputPeer = appPeersManager.getInputPeerByID(message.peerID);
    const messageID = message.id;

    return apiManager.invokeApi('messages.getPollResults', {
      peer: inputPeer,
      msg_id: messageID
    }).then(updates => {
      apiUpdatesManager.processUpdateMessage(updates);
      this.log('getResults updates:', updates);
    });
  }

  public getVotes(mid: number, option?: Uint8Array, offset?: string, limit = 20) {
    const message = appMessagesManager.getMessage(mid);
    const inputPeer = appPeersManager.getInputPeerByID(message.peerID);
    const messageID = message.id;

    let flags = 0;
    if(option) {
      flags |= 1 << 0;
    }

    if(offset) {
      flags |= 1 << 1;
    }

    return apiManager.invokeApi('messages.getPollVotes', {
      flags,
      peer: inputPeer,
      id: messageID,
      option,
      offset,
      limit
    }).then((votesList) => {
      this.log('getPollVotes messages:', votesList);

      appUsersManager.saveApiUsers(votesList.users);

      return votesList;
    });
  }

  public stopPoll(mid: number) {
    const message = appMessagesManager.getMessage(mid);
    const poll: Poll = message.media.poll;
    
    if(poll.pFlags.closed) return Promise.resolve();

    const newPoll = copy(poll);
    newPoll.pFlags.closed = true;
    return appMessagesManager.editMessage(mid, undefined, {
      newMedia: this.getInputMediaPoll(newPoll)
    }).then(() => {
      //console.log('stopped poll');
    }, err => {
      this.log.error('stopPoll error:', err);
    });
  }
}

const appPollsManager = new AppPollsManager();
MOUNT_CLASS_TO && (MOUNT_CLASS_TO.appPollsManager = appPollsManager);
export default appPollsManager;