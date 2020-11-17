import { readFileSync } from 'fs'
import { PubSub } from 'graphql-yoga'
import path from 'path'
import { getRepository } from 'typeorm'
import { check } from '../../../common/src/util'
import { ActiveBid } from '../entities/ActiveBid'
import { Auction } from '../entities/Auction'
import { AuctionTopBid } from '../entities/AuctionTopBid'
import { Purchase } from '../entities/Purchase'
import { Survey } from '../entities/Survey'
import { SurveyAnswer } from '../entities/SurveyAnswer'
import { SurveyQuestion } from '../entities/SurveyQuestion'
import { User } from '../entities/User'
import { ItemStatus, Resolvers } from './schema.types'

export const pubsub = new PubSub()

export function getSchema() {
  const schema = readFileSync(path.join(__dirname, 'schema.graphql'))
  return schema.toString()
}

interface Context {
  user: User | null
  request: Request
  response: Response
  pubsub: PubSub
}

export const graphqlRoot: Resolvers<Context> = {
  Query: {
    self: (_, args, ctx) => ctx.user,
    survey: async (_, { surveyId }) => (await Survey.findOne({ where: { id: surveyId } })) || null,
    surveys: () => Survey.find(),
    auctions: async () => {
      const auctionTopBids = await AuctionTopBid.find()
      if (auctionTopBids.length !== 0) {
        return auctionTopBids
      }
      const auctions = await Auction.find()
      const newAuctionTopBids = auctions.map(auction => {
        const auctionTopBid = new AuctionTopBid()
        auctionTopBid.auction = auction
        //const auctionEndDate = new Date(auction.timeCreated.getTime() + auction.auctionTime * 1000)
        const auctionEndDate = new Date(auction.timeCreated.getTime() + auction.auctionTime * 1000)
        auctionTopBid.auctionStartTime = auctionEndDate.toString()
        auctionTopBid.topBid = auction.price
        return auctionTopBid.save()
      })

      /*const newAuctionTimes = newAuctionTopBids.map(newAuctionTopBids=>{
        const auctionTime =
      })*/

      return await Promise.all(newAuctionTopBids)
    },
    auctionListing: async (_, { auctionId }) => {
      const auctionTopBid = await AuctionTopBid.findOneOrFail({ where: { id: auctionId } })
      return auctionTopBid
    },
    myListings: async (_, { sellerId }) => {
      const allMyListings = await getRepository(AuctionTopBid)
        .createQueryBuilder('allMyListings')
        .leftJoinAndSelect('allMyListings.auction', 'auction')
        .where('auction.sellerId = :sellerId', { sellerId })
        .getMany()

      return allMyListings
    },
    myActiveBids: async (_, { bidderId }) => {
      const allMyActiveBids = await ActiveBid.find({ where: { bidderId: bidderId } })
      return allMyActiveBids
    },
    myPurchases: async (_, { buyerId }) => {
      const allMyPurchases = await getRepository(Purchase)
        .createQueryBuilder('allMyPurchases')
        .leftJoinAndSelect('allMyPurchases.itemSold.auction', 'itemSold.auction')
        .where('itemSold.auction.currentHighestId = :buyerId', { buyerId })
        .getMany()

      return allMyPurchases
    },
  },
  Mutation: {
    answerSurvey: async (_, { input }, ctx) => {
      const { answer, questionId } = input
      const question = check(await SurveyQuestion.findOne({ where: { id: questionId }, relations: ['survey'] }))

      const surveyAnswer = new SurveyAnswer()
      surveyAnswer.question = question
      surveyAnswer.answer = answer
      await surveyAnswer.save()

      question.survey.currentQuestion?.answers.push(surveyAnswer)
      ctx.pubsub.publish('SURVEY_UPDATE_' + question.survey.id, question.survey)

      return true
    },
    nextSurveyQuestion: async (_, { surveyId }, ctx) => {
      // check(ctx.user?.userType === UserType.Admin)
      const survey = check(await Survey.findOne({ where: { id: surveyId } }))
      survey.currQuestion = survey.currQuestion == null ? 0 : survey.currQuestion + 1
      await survey.save()
      ctx.pubsub.publish('SURVEY_UPDATE_' + surveyId, survey)
      return survey
    },
    placeBid: async (_, { id, bidderId, bid }, ctx) => {
      const currentAuction = await Auction.findOne({ where: { id } })
      if (!currentAuction) {
        return false
      }
      const currentBid = await getRepository(AuctionTopBid)
        .createQueryBuilder('currentBid')
        .leftJoinAndSelect('currentBid.auction', 'auction')
        .where('auction.id = :id', { id })
        .getOne()
      if (!currentBid) {
        return false
      }

      if (currentBid.topBid > bid) {
        return false
      }
      currentAuction.currentHighestId = bidderId
      currentBid.topBid = bid
      await currentAuction.save()
      await currentBid.save()

      const activeBid = new ActiveBid()
      activeBid.bid = bid
      activeBid.bidderId = bidderId
      activeBid.auctionTopBid = currentBid
      activeBid.save()

      return true
    },

    createNewPurchase: async (_, { total, auctionTopBidId }, ctx) => {
      const newPurchase = new Purchase()
      newPurchase.total = total
      const id = auctionTopBidId
      const curAuctionTopBid = await AuctionTopBid.findOne({ where: { id } })
      if (curAuctionTopBid) {
        newPurchase.itemSold = curAuctionTopBid
        curAuctionTopBid.auction.status = ItemStatus.Sold
      } else {
        return false
      }

      newPurchase.save()
      return true
    },
  },

  Subscription: {
    surveyUpdates: {
      subscribe: (_, { surveyId }, context) => context.pubsub.asyncIterator('SURVEY_UPDATE_' + surveyId),
      resolve: (payload: any) => payload,
    },
  },
}
