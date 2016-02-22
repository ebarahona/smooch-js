import React from 'react';
import { render, unmountComponentAtNode } from 'react-dom';
import uuid from 'uuid';
import pick from 'lodash.pick';

import { store } from 'stores/app-store';

import { setAuth, resetAuth } from 'actions/auth-actions';
import { setUser, resetUser } from 'actions/user-actions';
import { setPublicKeys, setStripeInfo } from 'actions/app-actions';
import { updateText } from 'actions/ui-actions';
import { setConversation, resetConversation } from 'actions/conversation-actions';
import * as AppStateActions from 'actions/app-state-actions';
import { reset } from 'actions/common-actions';

import { login } from 'services/auth-service';
import { getAccount } from 'services/stripe-service';
import { EDITABLE_PROPERTIES, trackEvent, update as updateUser, immediateUpdate as immediateUpdateUser } from 'services/user-service';
import { getConversation, sendMessage, connectFaye, disconnectFaye, handleConversationUpdated } from 'services/conversation-service';

import { observable } from 'utils/events';
import { storage } from 'utils/storage';
import { waitForPage } from 'utils/dom';

function renderWidget(container) {
    const Root = (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test' ? require('./root-prod') : require('./root-dev')).Root;
    if (container) {
        render(<Root store={ store } />, container);
        return container;
    } else {
        const el = document.createElement('div');
        el.setAttribute('id', 'sk-holder');
        render(<Root store={ store } />, el);

        waitForPage().then(() => {
            document.body.appendChild(el);
        });

        return el;
    }
}

function renderLink() {
    const el = document.createElement('div');

    render(<a href='https://smooch.io?utm_source=widget'>In app messaging by smooch</a>, el);

    waitForPage().then(() => {
        document.body.appendChild(el);
        setTimeout(() => el.className = '', 200);
    });

    return el;
}

function getDeviceId() {
    const SK_STORAGE = 'sk_deviceid';
    const deviceId = storage.getItem(SK_STORAGE) ||
        uuid.v4().replace(/-/g, '');

    storage.setItem(SK_STORAGE, deviceId);

    return deviceId;
}

observable.on('message:sent', (message) => {
    observable.trigger('message', message);
});
observable.on('message:received', (message) => {
    observable.trigger('message', message);
});

export class Smooch {
    get VERSION() {
        return VERSION;
    }

    on() {
        return observable.on(...arguments);
    }

    off() {
        return observable.off(...arguments);
    }

    init(props) {

        if (/lebo|awle|pide|obo|rawli/i.test(navigator.userAgent)) {
            renderLink();
            observable.trigger('ready');
            return Promise.resolve();
        } else if (/PhantomJS/.test(navigator.userAgent) && process.env.NODE_ENV !== 'test') {
            return Promise.resolve();
        }

        this.appToken = props.appToken;

        if (props.emailCaptureEnabled) {
            store.dispatch(AppStateActions.enableSettings());
        } else {
            store.dispatch(AppStateActions.disableSettings());
        }

        store.dispatch(AppStateActions.setEmbedded(!!props.embedded));

        if (props.customText) {
            store.dispatch(updateText(props.customText));
        }

        if (props.serviceUrl) {
            store.dispatch(AppStateActions.setServerURL(props.serviceUrl));
        }

        return this.login(props.userId, props.jwt, pick(props, EDITABLE_PROPERTIES));
    }

    login(userId = '', jwt, attributes) {
        if (arguments.length === 2 && typeof jwt === 'object') {
            attributes = jwt;
            jwt = undefined;
        } else if (arguments.length < 3) {
            attributes = {};
        }

        // in case it comes from a previous authenticated state
        store.dispatch(resetAuth());
        store.dispatch(resetUser());
        store.dispatch(resetConversation());
        disconnectFaye();

        attributes = pick(attributes, EDITABLE_PROPERTIES);

        if (store.getState().appState.settingsEnabled && attributes.email) {
            store.dispatch(AppStateActions.setEmailReadonly());
        } else {
            store.dispatch(AppStateActions.unsetEmailReadonly());
        }

        return Promise.resolve().then(() => {
            store.dispatch(setAuth({
                jwt: jwt,
                appToken: this.appToken
            }));

            return login({
                userId: userId,
                device: {
                    platform: 'web',
                    id: getDeviceId(),
                    info: {
                        sdkVersion: VERSION,
                        URL: document.location.host,
                        userAgent: navigator.userAgent,
                        referrer: document.referrer,
                        browserLanguage: navigator.language,
                        currentUrl: document.location.href,
                        currentTitle: document.title
                    }
                }
            });
        }).then((loginResponse) => {
            store.dispatch(setUser(loginResponse.appUser));

            if (loginResponse.publicKeys) {
                store.dispatch(setPublicKeys(loginResponse.publicKeys));

                if (loginResponse.publicKeys.stripe) {
                    return getAccount().then((r) => {
                        store.dispatch(setStripeInfo(r.account));
                    }).catch(() => {
                        // do nothing about it and let the flow continue
                    });
                }
            }
        }).then(() => {
            return immediateUpdateUser(attributes).then(() => {
                const user = store.getState().user;
                if (user.conversationStarted) {
                    return getConversation().then(connectFaye);
                }
            });
        }).then(() => {
            if (!store.getState().appState.embedded) {
                if (!this._container) {
                    this._container = this.render();
                }
            }

            let user = store.getState().user;

            observable.trigger('ready', user);

            return user;
        });
    }

    logout() {
        return this.login();
    }

    track(eventName, userProps) {
        return trackEvent(eventName, userProps);
    }

    sendMessage(text) {
        return sendMessage(text);
    }

    updateUser(props) {
        return updateUser(props).then((response) => {
            if (response.appUser.conversationStarted) {
                return handleConversationUpdated().then(() => {
                    return response;
                });
            }

            return response;
        });
    }

    destroy() {
        let {embedded} = store.getState().appState;
        disconnectFaye();
        store.dispatch(reset());
        if (process.env.NODE_ENV !== 'test') {
            unmountComponentAtNode(this._container);
        }

        if (embedded) {
            // retain the embed mode
            store.dispatch(AppStateActions.setEmbedded(true));
        } else {
            document.body.removeChild(this._container);
        }

        delete this.appToken;
        delete this._container;
        observable.trigger('destroy');
    }

    open() {
        let {embedded} = store.getState().appState;
        if (!embedded) {
            store.dispatch(AppStateActions.openWidget());
        }
    }

    close() {
        let {embedded} = store.getState().appState;
        if (!embedded) {
            store.dispatch(AppStateActions.closeWidget());
        }
    }

    render(container) {
        this._container = container;
        return renderWidget(container);
    }
}