'use strict';

var express = require('express');
var app = express();
var catalyst = require('zcatalyst-sdk-node');
app.use(express.json());
var utils = require('./smsutils.js');
var oappsObj = require('./OappsFramework.js');
var ZDeskTickets = require('./ZDeskTickets.js');
var ZDeskExtra = require('./ZDeskExtra.js');
var ZDeskActor = require('./ZDeskActor.js');
var ZDeskThreads = require('./ZDeskThreads.js');
const PNF = require('google-libphonenumber').PhoneNumberFormat;
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
var catalystDBAccess = require('./catalystDBAccess.js');

//var client = require('twilio');


var customerNumber = "";
var configuredNumber = "";
var body = "";
var messageId = "";
var createdTime = "";
var fromCountry = "";
var toCountry = "";

var phoneRow, masterRow;


exports.methods = function () {

	this.setReceiveParams = function (req) {
		var receivedCustNumber = req.body.body.from.phoneNumber;
		receivedCustNumber = receivedCustNumber.replace(/ /g, "+"); //temporary solution
		this.customerNumber = receivedCustNumber;

		var receivedConfiguredNumber = req.body.to[0].phoneNumber;
		receivedConfiguredNumber = receivedConfiguredNumber.replace(/ /g, "+"); //temporary solution
		this.configuredNumber = receivedConfiguredNumber;

		this.body = req.body.body.subject;
		this.messageId = req.body.body.id;
		this.fromCountry = "";
		this.toCountry = "";
	}

	this.sendDirectParams = function (req) {
		var receivedCustNumber = req.body.To;
		receivedCustNumber = receivedCustNumber.replace(/ /g, "+"); //temporary solution
		this.customerNumber = receivedCustNumber;

		var receivedConfiguredNumber = req.body.From;
		receivedConfiguredNumber = receivedConfiguredNumber.replace(/ /g, "+"); //temporary solution
		this.configuredNumber = receivedConfiguredNumber;

		this.body = req.body.content;
		this.messageId = req.body.SmsSid;
		this.fromCountry = "";
		this.toCountry = "";
	}
	this.sendParams = function (req) {
		var extId = req.body.resource.extParentId;

		var phoneNumberArr = extId.split("::");
		var receivedCustNumber = phoneNumberArr[0];
		var receivedConfiguredNumber = phoneNumberArr[1];

		receivedCustNumber = receivedCustNumber.replace(/ /g, "+"); //temporary solution
		this.customerNumber = receivedCustNumber;

		receivedConfiguredNumber = receivedConfiguredNumber.replace(/ /g, "+"); //temporary solution
		this.configuredNumber = receivedConfiguredNumber;

		this.body = req.body.content;
		this.messageId = req.body.SmsSid;
		this.fromCountry = "";
		this.toCountry = "";
	}
	this.getParamsObj = function () {
		var paramsObj = {
			customerNumber: this.customerNumber,
			configuredNumber: this.configuredNumber,
			body: this.body,
			messageId: this.messageId,
			createdTime: this.createdTime,
			fromCountry: this.fromCountry,
			toCountry: this.toCountry
		};
		return paramsObj;
	};

	this.recieve = function (req) {
		return new Promise((resolve, reject) => {
			this.setReceiveParams(req);
			var thisObj = this;
			var orgId = req.query.orgId;
			var providerName = req.query.provider;
			
			catalystDBAccess.getMasterRow(req, orgId, providerName).then(function (dataStoredInDB) {
				if (dataStoredInDB != undefined && dataStoredInDB != null) {
					thisObj.masterRow = dataStoredInDB.master;
					thisObj.phoneRow = dataStoredInDB.phone;
					createTicketOrThread(thisObj.getParamsObj(), thisObj.masterRow, thisObj.phoneRow, true).then(function () {
						var apiResp = {
							'Content-Type': 'text/xml'
						}
						resolve(apiResp);
					});
				}
			});
		});
	}
	this.send = function (req) {
		return new Promise((resolve, reject) => {
			this.sendParams(req);

			var orgId = req.query.orgId;
			var pluginAppName = req.query.provider;
			var thisObj = this;
			catalystDBAccess.getMasterRow(req, orgId, pluginAppName).then(function (dataStoredInDB) {
				if (dataStoredInDB != undefined && dataStoredInDB != null) {
					thisObj.masterRow = dataStoredInDB.master;
					thisObj.phoneRow = dataStoredInDB.phone;

					var twilioAccountSid = thisObj.masterRow.TWILIO_ACCOUNT_SID;
					var twilioAuthToken = thisObj.masterRow.TWILIO_AUTH_TOKEN;
					var notifyServiceId = thisObj.phoneRow.NOTIFY_SERVICE_ID;
					var messageContent = req.body.resource.summary;
					var extId = req.body.resource.extParentId;
					var securityContext = thisObj.masterRow.SECURITY_CONTEXT;
					var ringcentralObj = new oappsObj.setMainInfo(securityContext,orgId,"ringcentraldesk","ringcentral-zoho");

					sendRCSMS(ringcentralObj,messageContent, extId).then(function (notification) {
						console.log("notification >>>>>>", notification.sid);

						const fromNumber = phoneUtil.parseAndKeepRawInput(thisObj.customerNumber, "");
						var formattedCustomerNumber = phoneUtil.format(fromNumber, PNF.INTERNATIONAL);

						const toNumber = phoneUtil.parseAndKeepRawInput(thisObj.configuredNumber, "");
						var formattedConfiguredNumber = phoneUtil.format(toNumber, PNF.INTERNATIONAL);

						var respJson = constructRespJson(notification.sid, formattedConfiguredNumber, formattedCustomerNumber);
						resolve(respJson);
					});
					
				}
			});
		});
	}
	this.sendDirect = function (req) {
		return new Promise((resolve, reject) => {
			var orgId = req.body.zohoOrgId;
			var pluginAppName = req.body.pluginAppName;

			this.sendDirectParams(req);
			var thisObj = this;
			catalystDBAccess.getMasterRow(req, orgId, pluginAppName).then(function (dataStoredInDB) {
				if (dataStoredInDB != undefined && dataStoredInDB != null) {
					thisObj.masterRow = dataStoredInDB.master;
					thisObj.phoneRow = dataStoredInDB.phone;

					createTicketOrThread(thisObj.getParamsObj(), thisObj.masterRow, thisObj.phoneRow, false).then(function () {
						var apiResp = {
							'success': 'true'
						}
						resolve(apiResp);
					}).catch(function () {
						var apiResp = {
							'success': 'false'
						}
						resolve(apiResp);
					});
				}
			});
		});
	}
}

function createTicketOrThread(msgObj, masterRow, phoneRow, isReceieveSMS) {
	return new Promise((resolve, reject) => {
		var isAcknowledgementConfigured = false;
		var isNewTicketCreationConfigured = false;
		var orgId = "";

		if (phoneRow != null) {
			isAcknowledgementConfigured = phoneRow.ACKNOWLEDGMENT_ENABLED;
			isNewTicketCreationConfigured = phoneRow.NEW_TICKET_CREATION_ENABLED;
			orgId = masterRow.ORG_ID;

			var extParentId = utils.getExtParentId(msgObj.customerNumber, msgObj.configuredNumber, isNewTicketCreationConfigured);
			var securityContext = masterRow.SECURITY_CONTEXT;

			var isTicketCreationNeeded = false;

			var zdeskObj = new oappsObj.setMainInfo(securityContext, orgId, "deskticketconnector", "oapps-twilio-bulk-sms");
			var contactName = msgObj.customerNumber;
			var storageKey = msgObj.customerNumber + "_" + msgObj.configuredNumber;
			storageKey = storageKey.replace(/ /g, "+"); //temporary solution
			storageKey = storageKey.replace(/\+/g, '');
			zdeskObj.getDataByStorageKey(storageKey).then(function (storageResponse) {
				var apiResp = utils.parseZohoDeskAPIResponse(storageResponse);
				var statusMsgJson = apiResp.statusMessage;
				var randomId = getRandomIdForLog();
				var identifier = "senddirect_" + randomId;
				if (isReceieveSMS) {
					identifier = "receivesms_" + randomId;
				}
				processTicketRelatedData(statusMsgJson, isNewTicketCreationConfigured, extParentId, zdeskObj, identifier).then(function (dataProcessed) {
					if (dataProcessed.isTicketCreationNeeded) {
						var messageSid = msgObj.messageId;

						var subjectText = "SMS from ";
						if (messageSid.startsWith("MM")) {
							subjectText = "MMS from ";
						}
						if (!isReceieveSMS) {
							subjectText = "SMS sent to ";
							if (messageSid.startsWith("MM")) {
								subjectText = "MMS sent to ";
							}
						}

						constructInboundTicketJson(msgObj, dataProcessed.contactName, dataProcessed.isAddedNew, dataProcessed.extParentId, zdeskObj, subjectText, isReceieveSMS);
					} else {
						if (msgObj.body.indexOf("Greetings from OAppS!") == -1) {
							constructInboundThreadJson(msgObj, dataProcessed.contactName, dataProcessed.extParentId, zdeskObj, msgObj.body, isReceieveSMS);
						}
					}
					if (isReceieveSMS && isAcknowledgementConfigured && isTicketCreationNeeded) {
						var acknowledgementText = phoneRow.ACKNOWLEDGEMENT;
						constructAcknowledgementThreadJson(msgObj, contactName, extParentId, zdeskObj, acknowledgementText);
					}
					zdeskObj.createTickets().then(function (apiResponse) {
						resolve(apiResponse);
					});
				});
			});
		}
	});
}
function getRandomIdForLog() {
	var result = '';
	var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var charactersLength = characters.length;
	for (var i = 0; i < 8; i++) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
	}
	return result;
}

function constructInboundTicketJson(msgInfoObj, contactName, isAddedNew, extId, zdeskObj, subjectText, isReceiveSMS) {
	var ticketObj = new ZDeskTickets.includeTicket();
	console.log(" msgInfoObj >>>>>>>>{0}", msgInfoObj);

	console.log(msgInfoObj);
	console.log(" msgInfoObj from ::::: from >>>>>>>>{0}", msgInfoObj);
	console.log(msgInfoObj.customerNumber);
	const fromNumber = phoneUtil.parseAndKeepRawInput(msgInfoObj.customerNumber, msgInfoObj.fromCountry);
	if (phoneUtil.isValidNumber(fromNumber)) {

		var formattedFromNumber = phoneUtil.format(fromNumber, PNF.INTERNATIONAL);

		var displayContactInfo = contactName;

		if (isAddedNew || displayContactInfo == "") {
			displayContactInfo = formattedFromNumber;
		}

		var subject = subjectText + displayContactInfo;
		var messageSid = msgInfoObj.messageId;
		var isMMS = false;
		if (messageSid.startsWith("MM")) {
			isMMS = true;
		}
		// var hasAttachment = false;

		ticketObj.setSubject(subject);
		ticketObj.setExtId(extId);
		ticketObj.setPhone(fromNumber.getRawInput() + "");
		ticketObj.setDescription(msgInfoObj.body);

		var actorObj = new ZDeskActor.includeActor();
		actorObj.setDisplayName(displayContactInfo);
		actorObj.setName(displayContactInfo);
		actorObj.setExtId(msgInfoObj.customerNumber);
		actorObj.setPhone(fromNumber.getRawInput() + "");

		var extraJson = {};
		extraJson.msgSID = msgInfoObj.messageId;
		extraJson.direction = "Inbound";
		extraJson.ticketid = "{{ticket.id}}";
		extraJson.extId = extId;

		var storageKey = msgInfoObj.customerNumber + "_" + msgInfoObj.configuredNumber;
		storageKey = storageKey.replace(/ /g, "+"); //temporary solution
		storageKey = storageKey.replace(/\+/g, '');

		console.log(" sendirect :::::: KEY_STORAGE_PUT >>>>" + storageKey);

		var extraObj = new ZDeskExtra.includeExtra();
		extraObj.setKey(storageKey);
		extraObj.setValue(JSON.stringify(extraJson));
		extraObj.setQueriableValue(storageKey);

		ticketObj.setExtra(extraObj.retrieveExtra());
		ticketObj.setActor(actorObj.retrieveActor());

		var ticketJson = ticketObj.retrieveTicket();

		zdeskObj.includeTicket(ticketJson);

	}

}

function constructInboundThreadJson(msgInfoObj, contactName, extId, zdeskObj, body, isReceiveSMS) {
	var threadObj = new ZDeskThreads.includeThread();
	const fromNumber = phoneUtil.parseAndKeepRawInput(msgInfoObj.customerNumber, msgInfoObj.fromCountry);

	if (phoneUtil.isValidNumber(fromNumber)) {
		var formattedFromNumber = phoneUtil.format(fromNumber, PNF.INTERNATIONAL);

		const toNumber = phoneUtil.parseAndKeepRawInput(msgInfoObj.configuredNumber, msgInfoObj.toCountry);
		var formattedToNumber = phoneUtil.format(toNumber, PNF.INTERNATIONAL);

		var displayContactInfo = contactName;

		if (displayContactInfo == undefined || displayContactInfo == "") {
			displayContactInfo = formattedFromNumber;
		}

		var messageSid = msgInfoObj.messageId;

		var isMMS = false;
		if (messageSid.startsWith("MM")) {
			isMMS = true;
		}
		// var hasAttachment = false;
		if (isMMS) {
			//hasAttachment = reqDetails.getNumMedia() > 0;
		}
		var toArray = [];
		toArray.push(isReceiveSMS ? formattedToNumber : formattedFromNumber);

		threadObj.setExtId(messageSid);
		threadObj.setExtParentId(extId);
		threadObj.setContent(body);
		threadObj.setDirection(isReceiveSMS ? "in" : "out");
		threadObj.setFrom(isReceiveSMS ? formattedFromNumber : formattedToNumber);
		threadObj.setTo(toArray);
		threadObj.setCanReply(true);
		if (msgInfoObj.createdTime != undefined) {
			threadObj.setCreatedTime(msgInfoObj.createdTime);
		}


		var actorObj = new ZDeskActor.includeActor()
		actorObj.setDisplayName(displayContactInfo);
		actorObj.setName(displayContactInfo);
		actorObj.setExtId(msgInfoObj.configuredNumber);
		actorObj.setPhone(formattedFromNumber);

		var extraJson = {};
		extraJson.msgSID = messageSid;
		extraJson.direction = isReceiveSMS ? "in" : "out";
		extraJson.ticketid = "{{ticket.id}}";
		extraJson.extId = extId;

		var storageKey = msgInfoObj.customerNumber + "_" + msgInfoObj.configuredNumber;
		storageKey = storageKey.replace(/ /g, "+"); //temporary solution
		storageKey = storageKey.replace(/\+/g, '');
		var extraObj = new ZDeskExtra.includeExtra();
		extraObj.setKey(storageKey);
		extraObj.setValue(JSON.stringify(extraJson));
		extraObj.setQueriableValue(storageKey);

		threadObj.setExtra(extraObj.retrieveExtra());
		threadObj.setActor(actorObj.retrieveActor());

		var threadJson = threadObj.retrieveThread();

		zdeskObj.includeThread(threadJson);

	}

}

function constructAcknowledgementThreadJson(msgInfoObj, contactName, extId, zdeskObj, body) {
	var threadObj = new ZDeskThreads.includeThread();
	const fromNumber = phoneUtil.parseAndKeepRawInput(msgInfoObj.customerNumber, msgInfoObj.fromCountry);
	if (phoneUtil.isValidNumber(fromNumber)) {
		var formattedFromNumber = phoneUtil.format(fromNumber, PNF.INTERNATIONAL);

		const toNumber = phoneUtil.parseAndKeepRawInput(msgInfoObj.configuredNumber, msgInfoObj.toCountry);
		var formattedToNumber = phoneUtil.format(toNumber, PNF.INTERNATIONAL);

		var displayContactInfo = contactName;

		if (displayContactInfo == undefined || displayContactInfo == "") {
			displayContactInfo = formattedFromNumber;
		}

		var messageSid = msgInfoObj.messageId;

		var isMMS = false;
		if (messageSid.startsWith("MM")) {
			isMMS = true;
		}
		// var hasAttachment = false;
		if (isMMS) {
			//hasAttachment = reqDetails.getNumMedia() > 0;
		}
		var fromArray = [];
		fromArray.push(formattedFromNumber);

		threadObj.setExtId(msgInfoObj.messageId);
		threadObj.setExtParentId(extId);
		threadObj.setContent(body);
		threadObj.setDirection("out");
		threadObj.setFrom(formattedToNumber);
		threadObj.setTo(fromArray);
		threadObj.setCanReply(true);
		threadObj.setCreatedTime(msgInfoObj.createdTime);

		var actorObj = new ZDeskActor.includeActor()
		actorObj.setDisplayName(displayContactInfo);
		actorObj.setName(displayContactInfo);
		actorObj.setExtId(msgInfoObj.configuredNumber);
		actorObj.setPhone(formattedToNumber);

		var extraJson = {};
		extraJson.msgSID = msgInfoObj.messageId;
		extraJson.direction = "out";
		extraJson.ticketid = "{{ticket.id}}";
		extraJson.extId = extId;

		var storageKey = msgInfoObj.customerNumber + "_" + msgInfoObj.configuredNumber;
		storageKey = storageKey.replace(/\+/g, "");

		var extraObj = new ZDeskExtra.includeExtra();
		extraObj.setKey(storageKey);
		extraObj.setValue(JSON.stringify(extraJson));
		extraObj.setQueriableValue(storageKey);

		threadObj.setExtra(extraObj.retrieveExtra());
		threadObj.setActor(actorObj.retrieveActor());

		var threadJson = threadObj.retrieveThread();

		zdeskObj.includeThread(threadJson);

	}

}

function processTicketRelatedData(statusMsgJson, isNewTicketCreationConfigured, extParentId, zdeskObj, identifier) {
	return new Promise((resolve, reject) => {
		var dataProcessed = {};
		dataProcessed.isAddedNew = false;
		dataProcessed.isTicketCreationNeeded = false;
		dataProcessed.extParentId = extParentId;
		dataProcessed.contactName = "";
		if (statusMsgJson.data != undefined) {
			var dataArray = statusMsgJson.data;
			if (dataArray != undefined && dataArray != null) {
				var queryJson = dataArray[0];
				var searchValueJson = queryJson.value;

				var ticketId = searchValueJson.ticketid;
				if (ticketId == undefined || ticketId == "") {
					dataProcessed.isTicketCreationNeeded = true;
				}
				if (isNewTicketCreationConfigured) {
					zdeskObj.setApiUrl("https://desk.zoho.com/api/v1/tickets/" + ticketId);
					zdeskObj.setApiMethod("GET");
					var queryParamsJson = {};
					queryParamsJson.include = "contacts";

					zdeskObj.setQueryParams(queryParamsJson);

					zdeskObj.invokeAPI().then(function (getTicketResponse) {
						try {
							var ticketResp = utils.parseZohoDeskAPIResponse(getTicketResponse);
							var isTicketOpenAndAvaialble = utils.checkTheTicketIsOpenAndAvailable(ticketResp);

							dataProcessed.contactName = utils.retriveContactName(ticketResp);

							if (isTicketOpenAndAvaialble) {
								dataProcessed.extParentId = searchValueJson.extId;
								dataProcessed.isTicketCreationNeeded = false;
							} else {
								dataProcessed.isTicketCreationNeeded = true;
							}
						} catch (error) {
							dataProcessed.isTicketCreationNeeded = true;
						}
						resolve(dataProcessed);
					});
				} else {
					dataProcessed.isAddedNew = true;
					resolve(dataProcessed);
				}
			} else {
				dataProcessed.isAddedNew = true;
				if (isNewTicketCreationConfigured) {
					dataProcessed.isTicketCreationNeeded = true;
				}
				resolve(dataProcessed);
			}
		} else {
			dataProcessed.isAddedNew = true;
			if (isNewTicketCreationConfigured) {
				dataProcessed.isTicketCreationNeeded = true;
			}
			resolve(dataProcessed);
		}
	});
}
function sendRCSMS(ringcentralObj,messageContent, extId){
	return new Promise((resolve,reject)=>{
		var split=extId.split(":");
		var fromNumber=split[0];
		var toNumber=split[1];	
		var sendSMSUrl = "https://platform.devtest.ringcentral.com/restapi/v1.0/account/~/extension/~/sms";
		ringcentralObj.setApiUrl(sendSMSUrl);
		ringcentralObj.setApiMethod("POST");
		var payLoad = {
			"to": [
				{
					"phoneNumber": fromNumber
				}
			],
			"from": {
				"phoneNumber":  toNumber
			},
			"text": messageContent
		}		
		ringcentralObj.setContentType("application/json");
		var body = JSON.stringify(payLoad);
		ringcentralObj.setPostBody(body);
		ringcentralObj.invokeAPI().then(function(smsResponse){
			console.log("sendSMS:::::smsResponse",smsResponse);
			var parsedJson = {};
			if(typeof smsResponse === "string"){
				parsedJson = JSON.parse(smsResponse);
			} else {
				parsedJson = smsResponse;
			}
			var parsedJsonResp = parsedJson.response;
			
			if(typeof parsedJsonResp === "string"){
				parsedJsonResp = JSON.parse(parsedJsonResp);
			}
			
			var id = parsedJsonResp.statusMessage.id;
			
			console.log("sendSMS::::::id",id);
			//var respSMS=JSON.parse(smsResponse);
			//console.log("<<<<<SMS response>>>>>")
			//console.log(respSMS);
			var respJson = constructRespJson(id,toNumber,fromNumber);
			resolve(respJson);
		}).catch(function(error){
			reject(error);
		});
	});
}
function constructRespJson (newThreadId, fromUserName,toUserName){
	var ticketJson = {};
	ticketJson.extId = newThreadId+"";
	ticketJson.canReply = true;
	ticketJson.from = fromUserName;
	
	var replyJsonArr = [];
	replyJsonArr.push(toUserName);
	
	ticketJson.to = replyJsonArr;
	return ticketJson;
}
function sendTwilioSMS(accSid, authToken, notifyServiceId, messageBody, extId) {
	return new Promise((resolve, reject) => {
		var sendSMS = function (bindingArray) {
			var twilioClient = new client(accSid, authToken);
			const service = twilioClient.notify.services(notifyServiceId);
			service.notifications
				.create({
					toBinding: bindingArray,
					body: messageBody,
				})
				.then(notification => {
					console.log(notification);
					resolve(notification);
				})
				.catch(error => {
					console.log(error);
				})
				.done();
		}
		getPhoneNumberBinding(extId, sendSMS);
	});
}

function getPhoneNumberBinding(extId, getAllBindingsCallBack) {
	var bindingArray = [];
	var phoneNumberArr = extId.split("::");
	var customerNumber = phoneNumberArr[0];

	var jsonBinding = {
		"binding_type": "sms",
		"address": customerNumber
	}
	bindingArray.push(JSON.stringify(jsonBinding));
	if (getAllBindingsCallBack != undefined) {
		getAllBindingsCallBack(bindingArray);
	}

}
function constructRespJson(notificationSid, from, to) {
	var ticketJson = {};
	ticketJson.extId = notificationSid;
	ticketJson.canReply = true;
	ticketJson.from = from;

	var replyJsonArr = [];
	replyJsonArr.push(to);

	ticketJson.to = replyJsonArr;
	return ticketJson;
}