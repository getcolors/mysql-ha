#!/usr/bin/env python3
"""Assign an existing endpoint after the caller has established primary ownership."""
import argparse
import http.client
import ipaddress
import json
import os
import time

ADAPTERS = {'digitalocean': {'token': 'COLORS_PAR_DO_TOKEN'}}

class EndpointError(Exception):
    pass

def request(method, path, token, body=None, timeout=20):
    connection = http.client.HTTPSConnection('api.digitalocean.com', timeout=timeout)
    try:
        payload = None if body is None else json.dumps(body)
        connection.request(method, path, payload, {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        response = connection.getresponse()
        content = response.read(2 * 1024 * 1024 + 1)
        if response.status not in (200, 201, 202) or len(content) > 2 * 1024 * 1024:
            raise EndpointError()
        return json.loads(content.decode('utf-8'))
    except Exception:
        raise EndpointError('endpoint API request failed') from None
    finally:
        connection.close()

def operate(provider, ip, node_id=None, action='assign', environment=None, transport=request, sleep=time.sleep, clock=time.monotonic):
    if provider not in ADAPTERS or action not in ('assign', 'status'):
        raise EndpointError('unsupported endpoint operation')
    try:
        if str(ipaddress.IPv4Address(ip)) != ip:
            raise ValueError()
        if action == 'assign' and (not isinstance(node_id, str) or not node_id.isascii() or not node_id.isdigit() or not 0 < int(node_id) <= 9007199254740991):
            raise ValueError()
    except Exception:
        raise EndpointError('invalid endpoint identity') from None
    env = os.environ if environment is None else environment
    token = env.get(ADAPTERS[provider]['token'])
    if not isinstance(token, str) or not token.strip() or token.strip().upper() == 'REPLACE_ME' or any(char in token for char in '\r\n'):
        raise EndpointError('endpoint credential unavailable')
    path = '/v2/reserved_ips/' + ip
    deadline = clock() + 120
    def api(method, suffix='', body=None):
        remaining = deadline - clock()
        if remaining <= 0:
            raise EndpointError('endpoint confirmation timed out')
        try:
            return transport(method, path + suffix, token, body, min(20, remaining))
        except Exception:
            raise EndpointError('endpoint API request failed') from None
    def holder():
        result = api('GET')
        if not isinstance(result, dict) or not isinstance(result.get('reserved_ip'), dict):
            raise EndpointError('invalid endpoint observation')
        reserved = result['reserved_ip']
        if reserved.get('ip') != ip or 'droplet' not in reserved:
            raise EndpointError('invalid endpoint observation')
        droplet = reserved['droplet']
        if droplet is None:
            return None
        value = droplet.get('id') if isinstance(droplet, dict) else None
        if type(value) is not int or not 0 < value <= 9007199254740991:
            raise EndpointError('invalid endpoint observation')
        return str(value)
    current = holder()
    if action == 'status':
        return {'status': 'present', 'node_id': current}
    node_id = str(int(node_id))
    if current == node_id:
        return {'status': 'assigned', 'node_id': node_id}
    def change(body):
        response = api('POST', '/actions', body)
        if not isinstance(response, dict) or not isinstance(response.get('action'), dict) or response['action'].get('status') not in ('in-progress', 'completed'):
            raise EndpointError('endpoint action refused')
    def confirmed(expected):
        for _ in range(60):
            if holder() == expected:
                return
            sleep(min(2, max(0, deadline - clock())))
        raise EndpointError('endpoint confirmation timed out')
    if current is not None:
        change({'type': 'unassign'})
        confirmed(None)
    change({'type': 'assign', 'droplet_id': int(node_id)})
    confirmed(node_id)
    return {'status': 'assigned', 'node_id': node_id}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', required=True)
    parser.add_argument('--ip', required=True)
    parser.add_argument('--node-id')
    parser.add_argument('--action', choices=('assign', 'status'), default='assign')
    args = parser.parse_args()
    try:
        result = operate(args.provider, args.ip, args.node_id, args.action)
    except Exception:
        print('{"status":"error"}')
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
