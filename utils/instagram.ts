import { InstagramEvent, InstagramEventOrganizer, InstagramPost, Prisma, PrismaClient } from "@prisma/client";
import { Configuration, OpenAIApi } from "openai";
import { logger as mainLogger } from './logger';
import vision from '@google-cloud/vision';
import { InstagramApiPost, InstagramSource } from "~~/types";
import { DateTime } from "luxon";
import { OpenAiInstagramResult, instagramInitialPrompt, executePrompt } from "./openai";
import eventSourcesJSON from 'public/event_sources.json';

if (!process.env.INSTAGRAM_BUSINESS_USER_ID) {
	throw new Error('INSTAGRAM_BUSINESS_USER_ID not found.');
}
if (!process.env.INSTAGRAM_USER_ACCESS_TOKEN) {
	throw new Error('INSTAGRAM_USER_ACCESS_TOKEN not found.');
}
if (!process.env.OPENAI_API_KEY) {
	throw new Error('OPENAI_API_KEY not found.');
}

const openai = new OpenAIApi(new Configuration({
	apiKey: process.env.OPENAI_API_KEY,
}));
const prisma = new PrismaClient();
const logger = mainLogger.child({ provider: 'instagram' });

async function fetchOcrResults(urls: string[]) {
	if (!process.env.GOOGLE_CLOUD_VISION_PRIVATE_KEY) {
		throw new Error('GOOGLE_CLOUD_VISION_PRIVATE_KEY not found.');
	}
	if (!process.env.GOOGLE_CLOUD_VISION_CLIENT_EMAIL) {
		throw new Error('GOOGLE_CLOUD_VISION_CLIENT_EMAIL not found.');
	}
	const client = new vision.ImageAnnotatorClient({
		scopes: ['https://www.googleapis.com/auth/cloud-platform'],
		credentials: {
			private_key: process.env.GOOGLE_CLOUD_VISION_PRIVATE_KEY.replace(/\\n/g, '\n'),
			client_email: process.env.GOOGLE_CLOUD_VISION_CLIENT_EMAIL,
		},
	});

	const annotationsAll = await Promise.all(
		urls.map(async (url) => {
			const [result] = await client.textDetection(url);
			const annotations = (result.textAnnotations && result.textAnnotations.length > 0) ?
				result.fullTextAnnotation.text : '';
			return annotations;
		}));

	const result = annotationsAll.join('\n');
	return result;
}

function instagramURL(sourceUsername: string) {
	return `https://graph.facebook.com/v16.0/${process.env.INSTAGRAM_BUSINESS_USER_ID}?fields=`
		+ `business_discovery.username(${sourceUsername}){media.limit(5){caption,permalink,timestamp,media_type,media_url,children{media_url,media_type}}}`
		+ `&access_token=${process.env.INSTAGRAM_USER_ACCESS_TOKEN}`
}

// Fetches the five most recent posts from the given Instagram account.
async function fetchPosts(organizer: InstagramEventOrganizer): Promise<InstagramApiPost[]> {
	const response = await fetch(instagramURL(organizer.username));

	const rateLimitHeader = response.headers.get('X-App-Usage');
	if (rateLimitHeader) {
		const appUsage = JSON.parse(rateLimitHeader);

		const callCount = appUsage.call_count;
		const totalCPUTime = appUsage.total_cputime;
		const totalTime = appUsage.total_time;
		if (callCount >= 100 || totalCPUTime >= 100 || totalTime >= 100) {
			// TODO: handle this more gracefully
			throw new Error(`Instagram rate limit hit: calls: ${callCount}, cpuTime: ${totalCPUTime}, time: ${totalTime}`);
		}

		logger.debug({ appUsage, username: organizer.username }, 'Current rate limit')
	}

	const responseBody = await response.json();

	if (responseBody.error) {
		throw new Error(responseBody.error.message);
	}

	return responseBody.business_discovery.media.data;
}

async function extractEventFromPost(organizer: InstagramEventOrganizer, post: InstagramPost): Promise<InstagramEvent | null> {
	const imageText = await extractTextFromPostImages(post);

	const inference = await runInferenceOnPost(organizer, post, imageText);
	if (!inference) {
		return null;
	}

	return await persistEvent(inference, post, organizer);
}

async function persistEvent(inference: OpenAiInstagramResult, post: InstagramPost, organizer: InstagramEventOrganizer): Promise<InstagramEvent | null> {
	if (inference.isEvent === true
		&& inference.startDay !== null
		&& inference.startHourMilitaryTime !== null
		&& inference.endHourMilitaryTime !== null
		&& inference.startMinute !== null
		&& inference.endMinute !== null
		&& inference.endDay !== null
		&& inference.hasStartHourInPost === true
		&& inference.isPastEvent === false
	) {
		let end = DateTime.fromObject({ year: inference.endYear, month: inference.endMonth, day: inference.startDay, hour: inference.endHourMilitaryTime, minute: inference.endMinute }, { zone: 'America/Los_Angeles' });
		// Allow Luxon to automatically take care of overflow (i.e. day 32 of the month).
		end = end.plus({ days: inference.endDay - inference.startDay });

		await prisma.instagramEvent.create({
			data: {
				postID: post.id,
				start: DateTime.fromObject({ year: inference.startYear, month: inference.startMonth, day: inference.startDay, hour: inference.startHourMilitaryTime, minute: inference.startMinute }, { zone: 'America/Los_Angeles' }).toUTC().toJSDate(),
				end: end.toUTC().toJSDate(),
				// start: new Date(Date.UTC(post.startYear, post.startMonth - 1, post.startDay, post.startHourMilitaryTime + PST_OFFSET)),
				// end: new Date(Date.UTC(post.endYear, post.endMonth - 1, post.endDay, post.endHourMilitaryTime + PST_OFFSET)),
				url: post.url,
				title: `${inference.title} @ ${organizer.username}`,
				organizerId: post.organizerId
			}
		});

		await prisma.instagramPost.update({
			where: { id: post.id },
			data: {
				completedAt: new Date(),
			}
		})
	}

	return null;
}


function fixGeneratedJson(generatedJson: string): string {
	return generatedJson.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
}

function postProcessOpenAiInstagramResponse(generatedJson: string): OpenAiInstagramResult {
	const object = JSON.parse(fixGeneratedJson(generatedJson));

	const hasAllProperties = object && Object.hasOwn(object, 'isEvent')
		&& Object.hasOwn(object, 'title')
		&& Object.hasOwn(object, 'startHourMilitaryTime')
		&& Object.hasOwn(object, 'endHourMilitaryTime')
		&& Object.hasOwn(object, 'isPastEvent')
		&& Object.hasOwn(object, 'hasStartHourInPost')
		&& Object.hasOwn(object, 'startMinute')
		&& Object.hasOwn(object, 'endMinute')
		&& Object.hasOwn(object, 'startDay')
		&& Object.hasOwn(object, 'endDay')
		&& Object.hasOwn(object, 'startMonth')
		&& Object.hasOwn(object, 'endMonth')
		&& Object.hasOwn(object, 'startYear')
		&& Object.hasOwn(object, 'endYear');
	if (!hasAllProperties) {
		throw new Error('JSON does not contain expected fields');
	}

	// Post-processing.
	if (object.startYear === null) {
		object.startYear = new Date().getFullYear();
	}
	if (object.endYear === null) {
		object.endYear = object.startYear;
	}
	if (object.startMinute === null) {
		object.startMinute = 0;
	}
	if (object.endMinute === null) {
		object.endMinute = 0;
	}
	if (object.startMonth === 12 && object.endMonth === 1) {
		object.endYear = object.startYear + 1;
	}
	if (object.endMonth === null) {
		object.endMonth = object.startMonth;
	}
	if (object.endDay === null) {
		object.endDay = object.startDay;
	}
	if (object.endHourMilitaryTime === null) {
		// End 2 hours from startHourMilitaryTime
		object.endHourMilitaryTime = object.startHourMilitaryTime + 2;
		if (object.endHourMilitaryTime > 23) {
			object.endHourMilitaryTime -= 24;
			object.endDay = object.startDay + 1; // Would this overflow the month? Need to check.
		}
	}

	return object;
}

async function runInferenceOnPost(organizer: InstagramEventOrganizer, apiPost: InstagramApiPost, ocrResult: string | null): Promise<OpenAiInstagramResult | null> {
	const initialPrompt = instagramInitialPrompt(organizer, apiPost, ocrResult);
	logger.debug({ prompt: initialPrompt }, 'Generated prompt for first round of inference')

	const initialResponse = await executePrompt(openai, initialPrompt);
	const generatedJson = initialResponse.choices[0].message?.content;
	if (!generatedJson) {
		return null;
	}

	// Todo: run verification prompt

	return postProcessOpenAiInstagramResponse(generatedJson);
}

function getMediaUrls(post: InstagramApiPost): string[] | null {
	switch (post.media_type) {
		case 'IMAGE':
			// May be omitted for legal reasons.
			if (post.media_url) {
				return [post.media_url];
			}

			return null;
		case 'CAROUSEL_ALBUM':
			return (post.children || { data: [] }).data
				.map((child) => child.media_url)
				// Keep only if defined, since it may be omitted.
				.filter((mediaUrl) => mediaUrl);
		case 'VIDEO':
			// TODO: We can OCR the thumbnail_url, but due to a bug on Instagram's end we cannot access the `thumbnail_url` field.
			// See https://developers.facebook.com/support/bugs/3431232597133817/?join_id=fa03b2657f7a9c for updates.
			return null;
		default:
			logger.error({ event: post }, `Unknown media type: ${post.media_type}`);
			return null;
	}
}

async function extractTextFromPostImages(post: InstagramPost): Promise<string | null> {
	const mediaUrls: string[] | null = JSON.parse(post.mediaUrlsJson);
	if (!mediaUrls) {
		return null;
	}

	return await fetchOcrResults(mediaUrls);
}

async function getOrInsertOrganizer(source: InstagramSource): Promise<InstagramEventOrganizer> {
	const organizer = await prisma.instagramEventOrganizer.findUnique({ where: { username: source.username } });
	if (organizer) {
		return organizer;
	}

	return await prisma.instagramEventOrganizer.create({
		data: {
			username: source.username,
			city: source.city,
			contextClues: source.context_clues.join(' '),
			// Set lastUpdated to as early as possible so that it will be updated first.
			lastUpdated: new Date(0),
		}
	});
}

type PostResponse = {
	post: InstagramPost,

}

/*
* Stores the post from the IG API in the database returning the model, returns `null` if the post already existed
*/
async function persistPostNoneIfPresent(organizer: InstagramEventOrganizer, post: InstagramApiPost): Promise<InstagramPost | null> {
	const mediaUrls = JSON.stringify(getMediaUrls(post));

	try {
		return await prisma.instagramPost.create({
			data: {
				id: post.id,
				url: post.permalink,
				organizerId: organizer.id,
				caption: post.caption,
				postDate: new Date(post.timestamp),
				mediaUrlsJson: mediaUrls,
			}
		});
	} catch (e) {
		if (e instanceof Prisma.PrismaClientKnownRequestError) {
			// This is the response code for a unique constraint violation - IE "the post id was already in the DB"
			if (e.code === 'P2002') {
				return null;
			}
		}

		throw e;
	}
}

/**
* Takes a given post, runs extractors on it if it's new, persists it to the
* database as an Event if extractors determine it's an event
* @param organizer
* @param apiPost
* @returns
*/
async function handleInstagramPost(organizer: InstagramEventOrganizer, apiPost: InstagramApiPost): Promise<InstagramEvent | null> {
	const dbPost = await persistPostNoneIfPresent(organizer, apiPost);
	if (!dbPost) {
		return null;
	}

	const maybeEvent = await extractEventFromPost(organizer, dbPost);
	if (!maybeEvent) {
		return null;
	}

	return maybeEvent;
}

async function ingestEventsForOrganizer(organizer: InstagramEventOrganizer): Promise<InstagramEvent[]> {
	try {
		const posts = await fetchPosts(organizer);

		const maybeEvents = await Promise.all(posts.map(post => handleInstagramPost(organizer, post)));

		const events: InstagramEvent[] = [];
		for (let maybeEvent of maybeEvents) {
			if (maybeEvent) {
				events.push(maybeEvent);
			}
		}

		return events;
	} catch (e) {
		logger.error({ error: e.toString(), organizer: organizer.username }, 'error ingesting for organizer')
		return [];
	}
}

export async function scrapeInstagramEventsForUser(username: string) {
	logger.info({ username, }, 'Starting Instagram data ingestion for user');
	const sources: InstagramSource[] = eventSourcesJSON.instagram;

	const filtered = sources.filter(source => source.username === username);
	if (!filtered) {
		throw new Error(`No Instagram account "${username}"`)
	}

	const source = filtered[0];

	const organizer = await getOrInsertOrganizer(source);
	const events = await ingestEventsForOrganizer(organizer);

	logger.info({ eventCount: events.length, username, }, 'Completed Instagram data ingestion');
}


export async function scrapeAllInstagramEvents() {
	logger.info('Starting Instagram data ingestion');
	// TODO: FIX THIS LINE SO WE SCRAPE THEM ALL!!
	const sources: InstagramSource[] = eventSourcesJSON.instagram;

	const countsBySource = await Promise.all(sources.map(async source => {
		const organizer = await getOrInsertOrganizer(source);
		const events = await ingestEventsForOrganizer(organizer);

		return { source, eventCount: events.length };
	}));

	logger.info({ countsBySource }, 'Completed Instagram data ingestion');
}

export async function fixupInstagramIngestion() {
	const incomplete = await findPosts({
		completedAt: null,
	});

	Promise.all(Object.values(incomplete).map(async ({ organization, posts }: { organization: InstagramEventOrganizer, posts: InstagramPost[] }) => {
		await Promise.all(posts.map(post => extractEventFromPost(organization, post)));
	}));
}

export interface FoundEvents {
	[organization_id: number]: { organization: InstagramEventOrganizer, events: InstagramEvent[] }
}

export interface FoundPosts {
	[organization_id: number]: { organization: InstagramEventOrganizer, posts: InstagramPost[] }
}

export async function findEvents(eventsWhere: any): Promise<FoundEvents> {
	const events = await prisma.instagramEvent.findMany({ where: eventsWhere });
	const organizers = await prisma.instagramEventOrganizer.findMany();
	const organizersById: FoundEvents = {};
	for (let organization of organizers) {
		organizersById[organization.id] = { organization, events: [] };
	}

	for (let event of events) {
		organizersById[event.organizerId].events.push(event);
	}

	return organizersById;
}

export async function findPosts(eventsWhere: any): Promise<FoundPosts> {
	const posts = await prisma.instagramPost.findMany({ where: eventsWhere });
	const organizers = await prisma.instagramEventOrganizer.findMany();
	const organizersById: FoundPosts = {};
	for (let organization of organizers) {
		organizersById[organization.id] = { organization, posts: [] };
	}

	for (let post of posts) {
		organizersById[post.organizerId].posts.push(post);
	}

	return organizersById;
}